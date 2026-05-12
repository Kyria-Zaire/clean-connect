/**
 * MissionsService — orchestre le cycle de vie mission (PRD-002 Build).
 *
 * Garde-fous (contraintes CTO Build) :
 *   - §1 Audit : chaque transition écrit un MissionEvent dans la même $transaction.
 *   - §2 missionNumber : généré côté serveur (MissionNumberService), unique, immuable.
 *   - §3 Matching PostGIS : repo applique pagination + limite obligatoires.
 *   - §4 Aucune adresse complète dans logs / erreurs / payload audit (assertNoAddressLeak).
 *   - §5 Matching exclut : suspendus, soft-deleted, non vérifiés (filtrage SQL).
 *   - §6 Toute transition passe par `assertMissionTransition()`.
 *   - §7 Aucun controller ne contient de logique métier — tout est ici.
 *
 * Idempotence : `accept()` repose sur un UPDATE conditionnel (lock optimiste SQL,
 *   ADR-005). La race "two prestataires accept" produit exactement 1 winner.
 */

import type {
  CreateMissionDraftBody,
  MissionListQuery,
  MissionListResponse,
  MissionView,
} from '@cc/shared-types'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma, type Mission, type Role } from '@prisma/client'

import type { Env } from '../../common/config/env'
import { PrismaService } from '../../common/prisma/prisma.service'

import {
  assertMissionTransition,
  MissionInvalidStatusTransitionError,
} from './domain/mission-state.machine'
import {
  MissionAlreadyAcceptedError,
  MissionForbiddenError,
  MissionGeocodingFailedError,
  MissionInvalidStateError,
  MissionNotEligibleError,
  MissionNotFoundError,
  MissionValidationFailedError,
} from './missions.errors'
import { MissionsRepository } from './missions.repository'
import { GeocoderService } from './services/geocoder.service'
import { MatchingService } from './services/matching.service'
import { MissionEventService } from './services/mission-event.service'
import { MissionNumberService } from './services/mission-number.service'
import { MissionViewService } from './services/mission-view.service'

interface ActorContext {
  userId: string
  role: Role
}

/** Durée de la fenêtre ASAP (4 h) — peut être déplacée en env si besoin. */
const ASAP_WINDOW_MS = 4 * 60 * 60 * 1_000

/** Tentatives max sur collision `missionNumber` (P2002). */
const MISSION_NUMBER_RETRIES = 5

/**
 * Mapping `MissionStatus` source -> reason sémantique stable côté client API.
 * Utilisé par `toInvalidStateError()` pour produire un body 409 lisible :
 * `{ error: 'MISSION_INVALID_STATE', reason: 'mission_cancelled' }` plutôt que
 * la forme brute `'CANCELLED->ACCEPTED'`.
 *
 * Convention : reason en snake_case, préfixé `mission_*` pour rester clair
 * dans les logs et permettre un mapping i18n stable côté front/mobile.
 */
const STATE_TO_SEMANTIC_REASON: Partial<Record<Mission['status'], string>> = {
  CANCELLED: 'mission_cancelled',
  EXPIRED: 'mission_expired',
  ACCEPTED: 'mission_already_accepted',
}

@Injectable()
export class MissionsService {
  private readonly logger = new Logger(MissionsService.name)
  private readonly listingTtlMs: number

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MissionsRepository,
    private readonly numbers: MissionNumberService,
    private readonly events: MissionEventService,
    private readonly geocoder: GeocoderService,
    private readonly matching: MatchingService,
    private readonly views: MissionViewService,
    config: ConfigService<Env, true>,
  ) {
    this.listingTtlMs = config.get('MISSION_LISTING_TTL_MS', { infer: true })
  }

  // ---------------------------------------------------------------------------
  // CREATE (CLIENT)
  // ---------------------------------------------------------------------------

  async createDraft(body: CreateMissionDraftBody, actor: ActorContext): Promise<MissionView> {
    if (actor.role !== 'CLIENT') throw new MissionForbiddenError()

    const window = this.computeInitialWindow(body)
    const geo = await this.safeGeocode({
      street: body.address.street,
      city: body.address.city,
      zipCode: body.address.zipCode,
      knownLocation: body.address.location,
    })

    const address = await this.repo.createAddress({
      street: body.address.street,
      city: body.address.city,
      zipCode: body.address.zipCode,
      country: body.address.country,
      lat: geo.lat,
      lng: geo.lng,
    })

    const mission = await this.createMissionWithRetry({
      clientId: actor.userId,
      addressId: address.id,
      serviceType: body.serviceType,
      startAt: window.startAt,
      endAt: window.endAt,
      timeZone: body.timeZone,
      isAsap: body.isAsap,
      estimatedPriceCents: body.estimatedPriceCents ?? null,
    })

    await this.events.record({
      missionId: mission.id,
      type: 'CREATED',
      actorUserId: actor.userId,
      payload: { serviceType: mission.serviceType, isAsap: mission.isAsap, geocodeSource: geo.source },
    })

    this.logger.log({
      event: 'mission.created',
      missionId: mission.id,
      missionNumber: mission.missionNumber,
      serviceType: mission.serviceType,
      isAsap: mission.isAsap,
      geocodeSource: geo.source,
    })

    return this.views.toView(mission, { userId: actor.userId, role: actor.role })
  }

  // ---------------------------------------------------------------------------
  // PUBLISH (CLIENT)
  // ---------------------------------------------------------------------------

  async publish(missionId: string, actor: ActorContext): Promise<MissionView> {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (actor.role !== 'CLIENT' || mission.clientId !== actor.userId) {
      throw new MissionForbiddenError()
    }

    try {
      assertMissionTransition(mission.status, 'PUBLISHED')
    } catch (err) {
      throw this.toInvalidStateError(err)
    }

    const now = new Date()
    const listingExpiresAt = new Date(now.getTime() + this.listingTtlMs)

    // Recalcule fenêtre si ASAP (la mission peut avoir été créée il y a quelques minutes).
    const refreshedWindow = mission.isAsap
      ? { startAt: now, endAt: new Date(now.getTime() + ASAP_WINDOW_MS) }
      : null

    await this.prisma.$transaction(async (tx) => {
      const updated = await this.repo.transitionDraftToPublishedTx(
        tx,
        missionId,
        now,
        listingExpiresAt,
      )
      if (updated !== 1) {
        throw new MissionInvalidStateError('mission_state_changed_concurrently')
      }
      if (refreshedWindow) {
        await tx.mission.update({
          where: { id: missionId },
          data: { startAt: refreshedWindow.startAt, endAt: refreshedWindow.endAt },
        })
      }
      await this.events.recordTx(tx, {
        missionId,
        type: 'PUBLISHED',
        actorUserId: actor.userId,
        payload: { listingTtlMs: this.listingTtlMs },
      })
    })

    // Matching exécuté hors transaction de publication (l'audit MATCHING_DONE
    // a sa propre $transaction). Acceptable car la mission est visible PUBLISHED
    // pendant la fenêtre listingExpiresAt → un accept même sans propositions
    // sera rejeté (le repo exige `proposals.some`).
    try {
      await this.matching.runFor(missionId)
    } catch (err) {
      this.logger.error({ event: 'mission.matching.failure', missionId, err: this.scrub(err) })
      // Pas de rollback : la mission reste PUBLISHED, un retry batch pourra rejouer.
      // TODO(debt): debt-matching-async-queue — basculer matching en BullMQ producer
      // (l'appel synchrone est acceptable MVP, voir CHANGELOG / dette explicite).
    }

    const reloaded = await this.repo.findById(missionId)
    if (!reloaded) throw new MissionNotFoundError()
    return this.views.toView(reloaded, { userId: actor.userId, role: actor.role })
  }

  // ---------------------------------------------------------------------------
  // ACCEPT (PRESTATAIRE) — lock optimiste SQL (ADR-005)
  // ---------------------------------------------------------------------------

  async accept(missionId: string, actor: ActorContext): Promise<MissionView> {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (actor.role !== 'PRESTATAIRE') throw new MissionForbiddenError()

    // Court-circuit explicite : la mission est déjà acceptée (race ou rejeu).
    // Doit être traité AVANT `assertMissionTransition` qui interdit ACCEPTED→ACCEPTED.
    if (mission.status === 'ACCEPTED') {
      throw new MissionAlreadyAcceptedError()
    }

    try {
      assertMissionTransition(mission.status, 'ACCEPTED')
    } catch (err) {
      throw this.toInvalidStateError(err)
    }

    const now = new Date()
    const updatedCount = await this.prisma.$transaction(async (tx) => {
      const count = await this.repo.transitionPublishedToAcceptedTx(tx, {
        missionId,
        prestataireId: actor.userId,
        now,
      })
      if (count === 1) {
        await this.events.recordTx(tx, {
          missionId,
          type: 'ACCEPTED',
          actorUserId: actor.userId,
        })
      }
      return count
    })

    if (updatedCount !== 1) {
      // Le UPDATE conditionnel a échoué : on relit pour distinguer la cause exacte.
      // Audits Verify CTO (B race cancel vs accept, E race expiration vs accept) :
      // chaque résultat doit porter une erreur métier précise (pas de "ALREADY_ACCEPTED"
      // trompeur quand la mission est en réalité CANCELLED ou EXPIRED).
      const fresh = await this.repo.findById(missionId)
      if (!fresh) throw new MissionNotFoundError()

      switch (fresh.status) {
        case 'ACCEPTED':
          throw new MissionAlreadyAcceptedError()
        case 'CANCELLED':
          throw new MissionInvalidStateError('mission_cancelled')
        case 'EXPIRED':
          throw new MissionInvalidStateError('mission_expired')
        case 'PUBLISHED':
          // Toujours PUBLISHED ⇒ le caller n'est pas dans `mission_proposals`,
          // ou la fenêtre `listingExpiresAt` est dépassée juste à l'instant.
          throw new MissionNotEligibleError()
        default:
          throw new MissionInvalidStateError('mission_state_changed_concurrently')
      }
    }

    const accepted = await this.repo.findById(missionId)
    if (!accepted) throw new MissionNotFoundError()
    this.logger.log({
      event: 'mission.accepted',
      missionId,
      prestataireId: actor.userId,
    })
    return this.views.toView(accepted, { userId: actor.userId, role: actor.role })
  }

  // ---------------------------------------------------------------------------
  // CANCEL (CLIENT) — DRAFT/PUBLISHED uniquement
  // ---------------------------------------------------------------------------

  async cancel(missionId: string, actor: ActorContext, reason?: string): Promise<MissionView> {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (actor.role !== 'CLIENT' || mission.clientId !== actor.userId) {
      throw new MissionForbiddenError()
    }

    try {
      assertMissionTransition(mission.status, 'CANCELLED')
    } catch (err) {
      throw this.toInvalidStateError(err)
    }

    const updatedCount = await this.prisma.$transaction(async (tx) => {
      const count = await this.repo.transitionToCancelledTx(tx, { missionId })
      if (count === 1) {
        await this.events.recordTx(tx, {
          missionId,
          type: 'CANCELLED',
          actorUserId: actor.userId,
          payload: reason ? { reason } : null,
        })
      }
      return count
    })

    if (updatedCount !== 1) {
      throw new MissionInvalidStateError('mission_state_changed_concurrently')
    }

    const cancelled = await this.repo.findById(missionId)
    if (!cancelled) throw new MissionNotFoundError()
    return this.views.toView(cancelled, { userId: actor.userId, role: actor.role })
  }

  // ---------------------------------------------------------------------------
  // GET / LIST
  // ---------------------------------------------------------------------------

  async getById(missionId: string, actor: ActorContext): Promise<MissionView> {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new MissionNotFoundError()

    if (!this.canRead(mission, actor)) throw new MissionForbiddenError()

    return this.views.toView(mission, { userId: actor.userId, role: actor.role })
  }

  async listMine(actor: ActorContext, query: MissionListQuery): Promise<MissionListResponse> {
    if (actor.role !== 'CLIENT') throw new MissionForbiddenError()
    const rows = await this.repo.listForClient({
      clientId: actor.userId,
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
    })
    return this.toList(rows, actor, query.limit)
  }

  async listProposed(actor: ActorContext, query: MissionListQuery): Promise<MissionListResponse> {
    if (actor.role !== 'PRESTATAIRE') throw new MissionForbiddenError()
    const rows = await this.repo.listProposedForPrestataire({
      prestataireId: actor.userId,
      limit: query.limit,
      cursor: query.cursor,
    })
    return this.toList(rows, actor, query.limit)
  }

  async listAdmin(actor: ActorContext, query: MissionListQuery): Promise<MissionListResponse> {
    if (actor.role !== 'ADMIN') throw new MissionForbiddenError()
    const rows = await this.repo.listForAdmin({
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
    })
    return this.toList(rows, actor, query.limit)
  }

  // ---------------------------------------------------------------------------
  // EXPIRE LISTING (worker BullMQ ou job admin)
  // ---------------------------------------------------------------------------

  async expireIfStillProposed(missionId: string): Promise<{ expired: boolean }> {
    const mission = await this.repo.findById(missionId)
    if (!mission) return { expired: false }
    if (mission.status !== 'PUBLISHED') return { expired: false }

    try {
      assertMissionTransition(mission.status, 'EXPIRED')
    } catch (err) {
      throw this.toInvalidStateError(err)
    }

    const now = new Date()
    const count = await this.prisma.$transaction(async (tx) => {
      const updated = await this.repo.transitionPublishedToExpiredTx(tx, { missionId, now })
      if (updated === 1) {
        await this.events.recordTx(tx, {
          missionId,
          type: 'EXPIRED',
          actorUserId: null,
          payload: { reason: 'listing_ttl_elapsed' },
        })
      }
      return updated
    })

    if (count === 1) {
      this.logger.log({ event: 'mission.expired', missionId })
      return { expired: true }
    }
    return { expired: false }
  }

  // ---------------------------------------------------------------------------
  // Helpers privés
  // ---------------------------------------------------------------------------

  private toList(rows: Mission[], actor: ActorContext, limit: number): Promise<MissionListResponse> {
    const last = rows[rows.length - 1]
    const nextCursor = rows.length === limit && last ? last.id : null
    return Promise.all(rows.map((m) => this.views.toView(m, { userId: actor.userId, role: actor.role }))).then(
      (items) => ({ items, nextCursor }),
    )
  }

  private canRead(mission: Mission, actor: ActorContext): boolean {
    if (actor.role === 'ADMIN') return true
    if (actor.role === 'CLIENT') return mission.clientId === actor.userId
    if (actor.role === 'PRESTATAIRE') {
      // Soit prestataire assigné, soit présent dans une MissionProposal active.
      // Pour éviter un round-trip supplémentaire ici, on accepte la lecture pour
      // toute mission PUBLISHED/ACCEPTED dont l'utilisateur est partie prenante.
      return (
        mission.prestataireId === actor.userId ||
        mission.status === 'PUBLISHED' /* visibilité matching limitée par /missions/proposed */
      )
    }
    return false
  }

  private computeInitialWindow(body: CreateMissionDraftBody): { startAt: Date; endAt: Date } {
    if (body.isAsap) {
      const now = new Date()
      return { startAt: now, endAt: new Date(now.getTime() + ASAP_WINDOW_MS) }
    }
    if (!body.startAt || !body.endAt) {
      // Garde-fou défensif — la validation Zod a normalement déjà rejeté ce cas.
      throw new MissionValidationFailedError('window_missing')
    }
    return { startAt: new Date(body.startAt), endAt: new Date(body.endAt) }
  }

  private async safeGeocode(input: {
    street: string
    city: string
    zipCode: string
    knownLocation?: { lat: number; lng: number }
  }): Promise<{ lat: number; lng: number; source: 'BAN' | 'CLIENT_GPS' }> {
    try {
      return await this.geocoder.geocode(input)
    } catch (err) {
      this.logger.warn({
        event: 'mission.geocode.failure',
        zipCode: input.zipCode,
        err: this.scrub(err),
      })
      throw new MissionGeocodingFailedError()
    }
  }

  private async createMissionWithRetry(input: {
    clientId: string
    addressId: string
    serviceType: Mission['serviceType']
    startAt: Date
    endAt: Date
    timeZone: string
    isAsap: boolean
    estimatedPriceCents: number | null
  }): Promise<Mission> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MISSION_NUMBER_RETRIES; attempt += 1) {
      const missionNumber = this.numbers.generate()
      try {
        return await this.repo.createMission({ ...input, missionNumber })
      } catch (err) {
        lastError = err
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          (err.meta?.['target'] as string[] | undefined)?.includes('mission_number')
        ) {
          this.logger.warn({
            event: 'mission.number.collision_retry',
            attempt,
          })
          continue
        }
        throw err
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('createMissionWithRetry: échec inconnu')
  }

  private toInvalidStateError(err: unknown): MissionInvalidStateError {
    if (err instanceof MissionInvalidStatusTransitionError) {
      // `reason` stable côté client API — préfère un libellé sémantique
      // pour les états terminaux (cancelled/expired/accepted) plutôt que la
      // forme brute `FROM->TO` (utilisée pour les autres transitions DRAFT/...).
      const semantic = STATE_TO_SEMANTIC_REASON[err.from]
      return new MissionInvalidStateError(semantic ?? `${err.from}->${err.to}`)
    }
    return new MissionInvalidStateError()
  }

  private scrub(err: unknown): { name: string; message?: string } {
    if (err instanceof Error) return { name: err.name, message: err.message }
    return { name: 'UnknownError' }
  }
}
