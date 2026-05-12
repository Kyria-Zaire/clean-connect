/**
 * MissionsRepository — accès Prisma (CRUD + lookups paginés + matching PostGIS).
 *
 * Aucun code métier : transitions de statut, matching, audit événementiel sont
 * orchestrés dans `MissionsService` (rule architecte-api).
 *
 * Particularités :
 *  - L'écriture du champ `addresses.location` (geography(Point, 4326)) passe
 *    par `$executeRawUnsafe` car non représentable Prisma (cf. ADR-003).
 *  - Le matching PostGIS (`findEligiblePrestataires`) utilise `$queryRaw`
 *    avec **limite serveur obligatoire** (contrainte CTO Build §3) et
 *    inclut TOUS les filtres d'éligibilité (suspendu / soft-deleted / non
 *    vérifié — contrainte CTO Build §5).
 */

import { Injectable } from '@nestjs/common'
import type { Prisma, Mission } from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'

export interface AddressInsertInput {
  street: string
  city: string
  zipCode: string
  country: string
  lat: number
  lng: number
}

export interface MissionInsertInput {
  missionNumber: string
  clientId: string
  addressId: string
  serviceType: Mission['serviceType']
  startAt: Date
  endAt: Date
  timeZone: string
  isAsap: boolean
  estimatedPriceCents: number | null
}

export interface EligiblePrestataireRow {
  id: string
  approximate_distance_m: number
}

@Injectable()
export class MissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Address
  // ---------------------------------------------------------------------------

  async createAddress(input: AddressInsertInput): Promise<{ id: string }> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "addresses" (
        "id", "street", "city", "zip_code", "country", "location", "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(),
        ${input.street},
        ${input.city},
        ${input.zipCode},
        ${input.country},
        ST_SetSRID(ST_MakePoint(${input.lng}::double precision, ${input.lat}::double precision), 4326)::geography,
        NOW(),
        NOW()
      )
      RETURNING "id"::text
    `
    const row = rows[0]
    if (!row) throw new Error('createAddress: aucune ligne insérée')
    return row
  }

  // ---------------------------------------------------------------------------
  // Mission CRUD
  // ---------------------------------------------------------------------------

  async createMission(input: MissionInsertInput): Promise<Mission> {
    return this.prisma.mission.create({
      data: {
        missionNumber: input.missionNumber,
        clientId: input.clientId,
        addressId: input.addressId,
        serviceType: input.serviceType,
        startAt: input.startAt,
        endAt: input.endAt,
        timeZone: input.timeZone,
        isAsap: input.isAsap,
        estimatedPriceCents: input.estimatedPriceCents,
      },
    })
  }

  findById(id: string): Promise<Mission | null> {
    return this.prisma.mission.findUnique({ where: { id } })
  }

  findByIdWithAddress(id: string): Promise<(Mission & { address: { id: string; street: string; city: string; zipCode: string; country: string } }) | null> {
    return this.prisma.mission.findUnique({
      where: { id },
      include: {
        address: {
          select: { id: true, street: true, city: true, zipCode: true, country: true },
        },
      },
    })
  }

  /**
   * Lookup adresse → renvoie aussi (lat, lng) extraits de la geography.
   * Utilisé par `MissionViewService` pour bâtir la `FullMissionAddress`.
   */
  async loadAddressWithCoords(addressId: string): Promise<{
    id: string
    street: string
    city: string
    zipCode: string
    country: string
    lat: number
    lng: number
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string
        street: string
        city: string
        zip_code: string
        country: string
        lat: number
        lng: number
      }>
    >`
      SELECT
        "id"::text         AS "id",
        "street",
        "city",
        "zip_code",
        "country",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "addresses"
      WHERE "id" = ${addressId}::uuid
      LIMIT 1
    `
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      street: row.street,
      city: row.city,
      zipCode: row.zip_code,
      country: row.country,
      lat: Number(row.lat),
      lng: Number(row.lng),
    }
  }

  // ---------------------------------------------------------------------------
  // Listings paginés (cursor-based)
  // ---------------------------------------------------------------------------

  async listForClient(opts: {
    clientId: string
    limit: number
    cursor?: string
    status?: Mission['status']
  }): Promise<Mission[]> {
    return this.prisma.mission.findMany({
      where: {
        clientId: opts.clientId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  async listProposedForPrestataire(opts: {
    prestataireId: string
    limit: number
    cursor?: string
  }): Promise<Mission[]> {
    return this.prisma.mission.findMany({
      where: {
        status: 'PUBLISHED',
        proposals: { some: { prestataireId: opts.prestataireId } },
        listingExpiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  async listForAdmin(opts: {
    limit: number
    cursor?: string
    status?: Mission['status']
  }): Promise<Mission[]> {
    return this.prisma.mission.findMany({
      where: opts.status ? { status: opts.status } : {},
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  // ---------------------------------------------------------------------------
  // Matching PostGIS — contraintes CTO Build §3 + §5
  // ---------------------------------------------------------------------------

  /**
   * Renvoie les prestataires éligibles pour la mission (ordre : distance asc).
   *
   *  - Limite serveur (`limit`) **obligatoire** — pas de full-scan.
   *  - Filtres exclusion : `deleted_at IS NULL`, `verified_at IS NOT NULL`,
   *    `suspended_at IS NULL`, `role = 'PRESTATAIRE'`.
   *  - `ST_DWithin(p.location, m.location, p.service_radius_km * 1000)` —
   *    matching dans le rayon d'intervention déclaré du prestataire.
   *  - Plafond global de rayon (max `serviceRadiusKm = 30`) déjà appliqué
   *    par CHECK SQL en migration.
   */
  async findEligiblePrestataires(opts: {
    missionId: string
    limit: number
  }): Promise<EligiblePrestataireRow[]> {
    return this.prisma.$queryRaw<EligiblePrestataireRow[]>`
      SELECT
        u."id"::text AS "id",
        ST_Distance(addr_p."location", addr_m."location") AS "approximate_distance_m"
      FROM "missions" m
      JOIN "addresses" addr_m ON addr_m."id" = m."address_id"
      JOIN "users" u
        ON u."role" = 'PRESTATAIRE'
       AND u."deleted_at" IS NULL
       AND u."verified_at" IS NOT NULL
       AND u."suspended_at" IS NULL
       AND u."address_id" IS NOT NULL
      JOIN "addresses" addr_p ON addr_p."id" = u."address_id"
      WHERE m."id" = ${opts.missionId}::uuid
        AND ST_DWithin(addr_p."location", addr_m."location", u."service_radius_km" * 1000)
      ORDER BY "approximate_distance_m" ASC
      LIMIT ${opts.limit}
    `
  }

  async insertProposalsTx(
    tx: Prisma.TransactionClient,
    missionId: string,
    prestataireIds: string[],
  ): Promise<number> {
    if (prestataireIds.length === 0) return 0
    const result = await tx.missionProposal.createMany({
      data: prestataireIds.map((pid) => ({ missionId, prestataireId: pid })),
      skipDuplicates: true,
    })
    return result.count
  }

  // ---------------------------------------------------------------------------
  // Mutations transactionnelles
  // ---------------------------------------------------------------------------

  /**
   * Marque la mission `PUBLISHED` à condition qu'elle soit toujours en `DRAFT`.
   * Renvoie 1 si OK, 0 sinon (le caller doit retourner une erreur métier).
   */
  async transitionDraftToPublishedTx(
    tx: Prisma.TransactionClient,
    missionId: string,
    publishedAt: Date,
    listingExpiresAt: Date,
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: { id: missionId, status: 'DRAFT' },
      data: { status: 'PUBLISHED', publishedAt, listingExpiresAt },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.2 — transition `DRAFT → PENDING_PAYMENT` (création
   * PaymentIntent). Lock optimiste : si la mission n'est plus en `DRAFT`
   * (annulée concurremment, déjà passée en `PENDING_PAYMENT` via replay),
   * renvoie 0 et le caller bascule sur la branche idempotente.
   */
  async transitionDraftToPendingPaymentTx(
    tx: Prisma.TransactionClient,
    missionId: string,
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: { id: missionId, status: 'DRAFT' },
      data: { status: 'PENDING_PAYMENT' },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.2 — transition `PENDING_PAYMENT → PUBLISHED` (webhook
   * Stripe `payment_intent.amount_capturable_updated`).
   *
   * Atomique : pose `publishedAt` + `listingExpiresAt` dans la même UPDATE
   * pour ne pas créer de race avec le matching. Renvoie 0 si la mission a
   * déjà été publiée par un replay de webhook (idempotent).
   */
  async transitionPendingPaymentToPublishedTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; publishedAt: Date; listingExpiresAt: Date },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: { id: opts.missionId, status: 'PENDING_PAYMENT' },
      data: {
        status: 'PUBLISHED',
        publishedAt: opts.publishedAt,
        listingExpiresAt: opts.listingExpiresAt,
      },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.2 — webhook `payment_intent.canceled` : la mission
   * doit basculer en `CANCELLED` (ne reste pas bloquée en `PENDING_PAYMENT`).
   * Lock idempotent : retourne 0 si la mission n'est plus en `PENDING_PAYMENT`.
   */
  async transitionPendingPaymentToCancelledTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: { id: opts.missionId, status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED' },
    })
    return result.count
  }

  /**
   * Lock optimiste — accept first-wins (ADR-005). Une seule UPDATE conditionnée :
   *  - mission encore PUBLISHED
   *  - encore non expirée
   *  - prestataire dans les MissionProposal (= éligible matching)
   * `prestataireId` est positionné dans la même requête (atomique).
   */
  async transitionPublishedToAcceptedTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; prestataireId: string; now: Date },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: {
        id: opts.missionId,
        status: 'PUBLISHED',
        listingExpiresAt: { gt: opts.now },
        proposals: { some: { prestataireId: opts.prestataireId } },
      },
      data: { status: 'ACCEPTED', prestataireId: opts.prestataireId },
    })
    return result.count
  }

  async transitionToCancelledTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: {
        id: opts.missionId,
        status: { in: ['DRAFT', 'PUBLISHED'] },
      },
      data: { status: 'CANCELLED' },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.4 — transition `ACCEPTED → CLIENT_VALIDATION_PENDING`
   * (POST /v1/missions/:id/complete, prestataire assigné).
   *
   * Lock optimiste : `prestataireId` est revérifié dans la `WHERE` pour
   * couper court à toute race entre `accept()` concurrent et `complete()`.
   * Renvoie 0 si la mission n'est plus en ACCEPTED, n'appartient plus
   * au prestataire, ou a déjà été basculée en CLIENT_VALIDATION_PENDING.
   */
  async transitionAcceptedToClientValidationPendingTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; prestataireId: string },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: {
        id: opts.missionId,
        status: 'ACCEPTED',
        prestataireId: opts.prestataireId,
      },
      data: { status: 'CLIENT_VALIDATION_PENDING' },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.4 — transition `CLIENT_VALIDATION_PENDING → DISPUTE_OPEN`
   * (POST /v1/missions/:id/report-problem, client owner).
   *
   * `clientId` re-vérifié pour anti-cross-mission. Bloque l'auto-release
   * (BullMQ job sera annulé par `AutoReleaseService.cancel` dans la
   * même transaction côté caller).
   */
  async transitionClientValidationPendingToDisputeOpenTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; clientId: string },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: {
        id: opts.missionId,
        status: 'CLIENT_VALIDATION_PENDING',
        clientId: opts.clientId,
      },
      data: { status: 'DISPUTE_OPEN' },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.4 — transition `CLIENT_VALIDATION_PENDING → COMPLETED`
   * (webhook `payment_intent.succeeded`, jamais sync HTTP).
   *
   * Idempotent : renvoie 0 si la mission a déjà été basculée (replay
   * webhook ou cron safety-net Ticket 3.5).
   */
  async transitionClientValidationPendingToCompletedTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; now: Date },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: { id: opts.missionId, status: 'CLIENT_VALIDATION_PENDING' },
      data: { status: 'COMPLETED', updatedAt: opts.now },
    })
    return result.count
  }

  async findExpiredPublishedIds(opts: { now: Date; limit: number }): Promise<string[]> {
    const rows = await this.prisma.mission.findMany({
      where: {
        status: 'PUBLISHED',
        listingExpiresAt: { lte: opts.now },
      },
      select: { id: true },
      take: opts.limit,
    })
    return rows.map((r) => r.id)
  }

  async transitionPublishedToExpiredTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; now: Date },
  ): Promise<number> {
    const result = await tx.mission.updateMany({
      where: {
        id: opts.missionId,
        status: 'PUBLISHED',
        listingExpiresAt: { lte: opts.now },
      },
      data: { status: 'EXPIRED' },
    })
    return result.count
  }
}
