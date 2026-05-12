/**
 * PRD-003 Ticket 3.4 — `MissionCompletionService`.
 *
 * Orchestre les trois actions terminales du cycle mission :
 *  - `POST /v1/missions/:id/complete`   (PRESTATAIRE) — Acceptée → CLIENT_VALIDATION_PENDING.
 *  - `POST /v1/missions/:id/validate`   (CLIENT)     — déclenche capture Stripe (SYSTEM).
 *  - `POST /v1/missions/:id/report-problem` (CLIENT) — CLIENT_VALIDATION_PENDING → DISPUTE_OPEN.
 *
 * Garde-fous (audit Verify D3 / D8) :
 *  - Toute transition mission est dans une `$transaction` Prisma avec audit
 *    `MissionEvent` (rule architecte-api §découpage).
 *  - L'`AutoReleaseJob` BullMQ est créé dans la **même transaction** que la
 *    bascule `ACCEPTED → CLIENT_VALIDATION_PENDING` ; le `queue.add(...)`
 *    BullMQ est posté APRÈS commit pour éviter qu'un job soit posté sans
 *    ligne DB associée (race rollback).
 *  - `validate` et `reportProblem` annulent le job BullMQ de manière
 *    idempotente — race `validate` vs `auto-release` réglée côté Stripe
 *    via idempotency-key (`capture-mission-<id>`).
 *
 * Hors-scope 3.4 (Ticket 3.5) :
 *  - `stripe.transfers.create` (transfer prestataire post-capture).
 *  - Refund orchestration.
 *  - DLQ admin replay.
 *  - Endpoint `/start` (transition `ACCEPTED → IN_PROGRESS`).
 */

import type { MissionView, ReportMissionProblemBody } from '@cc/shared-types'
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import {
  MissionForbiddenError,
  MissionInvalidStateError,
  MissionNotFoundError,
} from '../missions/missions.errors'
import { MissionsRepository } from '../missions/missions.repository'
import { MissionEventService } from '../missions/services/mission-event.service'
import { MissionViewService } from '../missions/services/mission-view.service'
import { PaymentsService } from '../payments/payments.service'

import { AutoReleaseService } from './auto-release/auto-release.service'
import {
  MissionClientOnlyException,
  MissionDisputeAlreadyOpenException,
  MissionNotCompletableException,
  MissionNotValidatableException,
  MissionPhotosInsufficientException,
  MissionPrestataireOnlyException,
} from './mission-completion.errors'
import { MissionPhotoQuotaService } from './photo-quota.service'

interface ActorContext {
  userId: string
  role: 'CLIENT' | 'PRESTATAIRE' | 'ADMIN'
}

export interface MissionCompletionResponse {
  mission: MissionView
  /** Replay safe : la transition était déjà effective avant cet appel. */
  idempotent: boolean
}

@Injectable()
export class MissionCompletionService {
  private readonly logger = new Logger(MissionCompletionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly missions: MissionsRepository,
    private readonly views: MissionViewService,
    private readonly missionEvents: MissionEventService,
    private readonly photoQuota: MissionPhotoQuotaService,
    private readonly autoRelease: AutoReleaseService,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /v1/missions/:id/complete (PRESTATAIRE)
  // ---------------------------------------------------------------------------

  /**
   * Prestataire assigné signale la fin de la prestation.
   *
   * Pré-conditions :
   *  - Mission existe + ownership prestataire OK.
   *  - Statut courant `ACCEPTED`.
   *  - Photos ≥ 3 BEFORE + ≥ 5 AFTER (DISPLAY syncées).
   *
   * Effets :
   *  1. Mission `ACCEPTED → CLIENT_VALIDATION_PENDING`.
   *  2. `AutoReleaseJob` SCHEDULED créé (T+48h ouvrées Europe/Paris) +
   *     delayed job BullMQ posté APRÈS commit DB.
   *  3. Audits `CLIENT_VALIDATION_PENDING` + `AUTO_RELEASE_SCHEDULED`.
   *
   * Idempotent : si la mission est déjà `CLIENT_VALIDATION_PENDING` et
   * appartient au prestataire, renvoie la mission avec `idempotent: true`
   * sans déclencher de side-effect (retry mobile safe).
   */
  async complete(missionId: string, actor: ActorContext): Promise<MissionCompletionResponse> {
    if (actor.role !== 'PRESTATAIRE') throw new MissionPrestataireOnlyException()

    const mission = await this.missions.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (mission.prestataireId !== actor.userId) throw new MissionPrestataireOnlyException()

    // Idempotence : déjà en CLIENT_VALIDATION_PENDING — pas de side-effect.
    if (mission.status === 'CLIENT_VALIDATION_PENDING') {
      const view = await this.views.toView(mission, actor)
      return { mission: view, idempotent: true }
    }
    if (mission.status !== 'ACCEPTED') {
      throw new MissionNotCompletableException(
        `mission_status_must_be_ACCEPTED (current: ${mission.status})`,
      )
    }

    // Vérif quotas photos AVANT toute mutation DB (UX fail-fast).
    const quotas = await this.photoQuota.check(missionId)
    if (!quotas.isComplete) {
      throw new MissionPhotosInsufficientException(
        `${quotas.reason} (before=${quotas.beforeCount}, after=${quotas.afterCount})`,
      )
    }

    const now = new Date()

    // Note TS : l'assignation à `plan` au sein d'une closure `$transaction`
    // ne propage pas le narrowing à l'extérieur — on retourne donc la
    // valeur directement depuis la transaction.
    const plan = await this.prisma.$transaction(async (tx) => {
      const transitioned = await this.missions.transitionAcceptedToClientValidationPendingTx(tx, {
        missionId,
        prestataireId: actor.userId,
      })
      if (transitioned !== 1) {
        // Race rare : `cancel` ou `accept` concurrent. Rollback transaction.
        throw new MissionInvalidStateError('mission_state_changed_concurrently')
      }

      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'CLIENT_VALIDATION_PENDING',
        actorUserId: actor.userId,
        payload: { beforeCount: quotas.beforeCount, afterCount: quotas.afterCount },
      })

      const scheduled = await this.autoRelease.scheduleTx(tx, { missionId, now })

      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'AUTO_RELEASE_SCHEDULED',
        actorUserId: actor.userId,
        payload: {
          autoReleaseJobId: scheduled.job.id,
          scheduledFor: scheduled.plan.scheduledFor.toISOString(),
        },
      })

      return {
        autoReleaseJobId: scheduled.job.id,
        bullJobId: scheduled.plan.bullJobId,
        scheduledFor: scheduled.plan.scheduledFor,
      }
    })

    // Post-commit : poste le delayed job BullMQ. Si Redis est down ici, on
    // log mais on N'échoue PAS l'HTTP (la mission est correctement bascu-
    // lée + audit est en place ; un cron safety-net horaire — Ticket 3.5 —
    // rejouera la planification à partir de la table `auto_release_jobs`).
    try {
      await this.autoRelease.enqueueDelayedJob({
        autoReleaseJobId: plan.autoReleaseJobId,
        missionId,
        scheduledFor: plan.scheduledFor,
        bullJobId: plan.bullJobId,
        now,
      })
    } catch (err) {
      this.logger.error(
        {
          missionId,
          autoReleaseJobId: plan.autoReleaseJobId,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'mission-completion.complete.enqueue_failed',
      )
      // TODO(debt): auto-release-safety-net-cron — Ticket 3.5 (rejoue
      // les jobs SCHEDULED non postés côté BullMQ).
    }

    const reloaded = await this.missions.findById(missionId)
    if (!reloaded) throw new MissionNotFoundError()
    const view = await this.views.toView(reloaded, actor)
    this.logger.log(
      {
        missionId,
        prestataireId: actor.userId,
        beforeCount: quotas.beforeCount,
        afterCount: quotas.afterCount,
        autoReleaseScheduledFor: plan.scheduledFor.toISOString(),
      },
      'mission-completion.complete.processed',
    )
    return { mission: view, idempotent: false }
  }

  // ---------------------------------------------------------------------------
  // POST /v1/missions/:id/validate (CLIENT)
  // ---------------------------------------------------------------------------

  /**
   * CLIENT owner valide manuellement la mission — déclenche la capture
   * Stripe immédiate (SYSTEM, trigger=CLIENT_VALIDATION).
   *
   * Pré-conditions :
   *  - Statut courant `CLIENT_VALIDATION_PENDING`.
   *  - Ownership CLIENT OK.
   *
   * Effets :
   *  1. Audit `CLIENT_VALIDATED`.
   *  2. Annulation `AutoReleaseJob` SCHEDULED (idempotent + retire job BullMQ).
   *  3. `PaymentsService.requestCapture(...)` — idempotency-key
   *     `capture-mission-<id>` (race auto-release safe côté Stripe).
   *  4. La mission reste en `CLIENT_VALIDATION_PENDING` jusqu'au webhook
   *     `payment_intent.succeeded` qui la fera passer en `COMPLETED`.
   *
   * Idempotent : si la mission est déjà COMPLETED (race avec
   * auto-release ou webhook), renvoie `idempotent: true`.
   */
  async validate(missionId: string, actor: ActorContext): Promise<MissionCompletionResponse> {
    if (actor.role !== 'CLIENT') throw new MissionClientOnlyException()

    const mission = await this.missions.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (mission.clientId !== actor.userId) throw new MissionClientOnlyException()

    if (mission.status === 'COMPLETED') {
      const view = await this.views.toView(mission, actor)
      return { mission: view, idempotent: true }
    }
    if (mission.status !== 'CLIENT_VALIDATION_PENDING') {
      throw new MissionNotValidatableException(
        `mission_status_must_be_CLIENT_VALIDATION_PENDING (current: ${mission.status})`,
      )
    }

    // Annulation BullMQ AVANT capture pour éviter la double exécution (et
    // si la capture échoue, l'auto-release n'aura pas l'opportunité de
    // s'exécuter avec un état Payment déjà bougé). Idempotent.
    await this.autoRelease.cancel({ missionId, reason: 'client_validated' })

    // Audit CLIENT_VALIDATED hors-transaction (la capture Stripe + webhook
    // feront leurs propres audits PAYMENT_CAPTURE_REQUESTED / CAPTURED).
    await this.missionEvents.record({
      missionId,
      type: 'CLIENT_VALIDATED',
      actorUserId: actor.userId,
      payload: null,
    })

    // Capture Stripe (SYSTEM trigger=CLIENT_VALIDATION) — race safe par
    // idempotency-key `capture-mission-<id>`. Si l'auto-release a déjà
    // capture (rare), `payment.status==='CAPTURED'` → no-op silencieux.
    await this.payments.requestCapture(missionId, {
      kind: 'SYSTEM',
      trigger: 'CLIENT_VALIDATION',
    })

    const reloaded = await this.missions.findById(missionId)
    if (!reloaded) throw new MissionNotFoundError()
    const view = await this.views.toView(reloaded, actor)
    this.logger.log(
      { missionId, clientId: actor.userId },
      'mission-completion.validate.processed',
    )
    return { mission: view, idempotent: false }
  }

  // ---------------------------------------------------------------------------
  // POST /v1/missions/:id/report-problem (CLIENT)
  // ---------------------------------------------------------------------------

  /**
   * CLIENT owner signale un problème — ouvre un litige (`DISPUTE_OPEN`).
   *
   * Pré-conditions :
   *  - Statut courant `CLIENT_VALIDATION_PENDING`.
   *  - Ownership CLIENT OK.
   *  - Pas déjà en `DISPUTE_OPEN` (idempotent → renvoie tel quel).
   *
   * Effets :
   *  1. Mission `CLIENT_VALIDATION_PENDING → DISPUTE_OPEN`.
   *  2. Annulation `AutoReleaseJob` SCHEDULED (idempotent).
   *  3. Audit `DISPUTE_OPENED` avec `category` (PAS la `description` —
   *     contient potentiellement des PII, on ne pollue pas l'audit).
   *
   * Hors-scope 3.4 (PRD-005) :
   *  - Workflow d'instruction admin (offre indemnité, validation finale).
   *  - Notification email admin / client.
   *  - Refund / re-capture après décision.
   */
  async reportProblem(
    missionId: string,
    actor: ActorContext,
    body: ReportMissionProblemBody,
  ): Promise<MissionCompletionResponse> {
    if (actor.role !== 'CLIENT') throw new MissionClientOnlyException()

    const mission = await this.missions.findById(missionId)
    if (!mission) throw new MissionNotFoundError()
    if (mission.clientId !== actor.userId) throw new MissionClientOnlyException()

    if (mission.status === 'DISPUTE_OPEN') {
      // Re-throw métier explicite : la mobile UI doit guider l'utilisateur
      // vers le suivi du litige plutôt que d'ouvrir un doublon.
      throw new MissionDisputeAlreadyOpenException()
    }
    if (mission.status !== 'CLIENT_VALIDATION_PENDING') {
      throw new MissionNotValidatableException(
        `mission_status_must_be_CLIENT_VALIDATION_PENDING (current: ${mission.status})`,
      )
    }

    await this.prisma.$transaction(async (tx) => {
      const transitioned = await this.missions.transitionClientValidationPendingToDisputeOpenTx(tx, {
        missionId,
        clientId: actor.userId,
      })
      if (transitioned !== 1) {
        throw new MissionInvalidStateError('mission_state_changed_concurrently')
      }
      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'DISPUTE_OPENED',
        actorUserId: actor.userId,
        // Description NON loggée (potentiellement PII) — uniquement la
        // catégorie pour permettre l'analytics admin (rule securite +
        // assertEventPayloadHygiene).
        payload: { category: body.category, descriptionLength: body.description.length },
      })
    })

    await this.autoRelease.cancel({ missionId, reason: 'dispute_opened' })

    const reloaded = await this.missions.findById(missionId)
    if (!reloaded) throw new MissionNotFoundError()
    const view = await this.views.toView(reloaded, actor)
    this.logger.log(
      { missionId, clientId: actor.userId, category: body.category },
      'mission-completion.report-problem.processed',
    )
    return { mission: view, idempotent: false }
  }
}

// Référencé via signature TS — évite "unused import" sur les erreurs metier
// si un futur refactor change la voie d'erreur.
export type _MissionCompletionTypeRefs = MissionForbiddenError
