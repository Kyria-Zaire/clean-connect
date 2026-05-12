/**
 * Contrats Zod — Mission (PRD-002 Design + Build).
 *
 * Source de vérité : `apps/api/prisma/schema.prisma` (Mission, MissionEvent,
 * MissionProposal, MissionStatus, MissionServiceType).
 *
 * Politique adresse (RGPD, ADR-005 / contrainte CTO Build §4) :
 *   - Avant acceptation, le prestataire ne reçoit qu'un `MaskedMissionAddress`
 *     (city + 3 premiers chars du code postal + distance approximative).
 *   - Après acceptation OU pour le client/admin, l'adresse complète est exposée.
 */

import { z } from 'zod'

import { MissionServiceTypeSchema, MissionStatusSchema } from './enums'
import { isoDateSchema, latitudeSchema, longitudeSchema, uuidSchema } from './primitives'

/** Adresse fournie à la création de mission : `location` est optionnel —
 *  le serveur géocode via BAN si absent (cf. ADR-006). */
export const missionAddressInputSchema = z
  .object({
    street: z.string().trim().min(1).max(255),
    city: z.string().trim().min(1).max(120),
    zipCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/u, 'Code postal FR (5 chiffres)')
      .max(10),
    country: z.string().length(2).default('FR'),
    location: z
      .object({
        lat: latitudeSchema,
        lng: longitudeSchema,
      })
      .optional(),
  })
  .strict()

export type MissionAddressInput = z.infer<typeof missionAddressInputSchema>

/** Corps `POST /missions` (brouillon). */
export const createMissionDraftBodySchema = z
  .object({
    serviceType: MissionServiceTypeSchema,
    address: missionAddressInputSchema,
    /** Si `true`, le service recalcule `startAt`/`endAt` à la publication (fenêtre ASAP). */
    isAsap: z.boolean().default(false),
    startAt: isoDateSchema.optional(),
    endAt: isoDateSchema.optional(),
    /** IANA, ex. `Europe/Paris` */
    timeZone: z.string().min(1).max(64),
    /** Estimation client — hors tarification PRD-002 (ADR-007). */
    estimatedPriceCents: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.isAsap) {
      if (!data.startAt || !data.endAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'startAt et endAt sont obligatoires lorsque isAsap=false.',
          path: ['startAt'],
        })
        return
      }
      if (new Date(data.endAt).getTime() <= new Date(data.startAt).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endAt doit être strictement après startAt.',
          path: ['endAt'],
        })
      }
    }
  })

export type CreateMissionDraftBody = z.infer<typeof createMissionDraftBodySchema>

/** Corps `POST /missions/:id/publish` — pas de body en MVP (déclenche matching). */
export const publishMissionBodySchema = z.object({}).strict()
export type PublishMissionBody = z.infer<typeof publishMissionBodySchema>

/** Corps `POST /missions/:id/accept` — prestataire confirme ; pas de body MVP. */
export const acceptMissionBodySchema = z.object({}).strict()
export type AcceptMissionBody = z.infer<typeof acceptMissionBodySchema>

/** Corps `DELETE /missions/:id` — annulation client en DRAFT/PUBLISHED. */
export const cancelMissionBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
export type CancelMissionBody = z.infer<typeof cancelMissionBodySchema>

// =============================================================================
// Address view — policy masquage RGPD avant acceptation
// =============================================================================

/** Adresse masquée pour prestataire avant acceptation (PRD-002 Q6 + contrainte CTO §4). */
export const maskedMissionAddressSchema = z
  .object({
    kind: z.literal('MASKED'),
    city: z.string(),
    partialZipCode: z.string(),
    approximateDistanceKm: z.number().nonnegative(),
  })
  .strict()
export type MaskedMissionAddress = z.infer<typeof maskedMissionAddressSchema>

/** Adresse complète — exposée client/admin OU prestataire après ACCEPTED. */
export const fullMissionAddressSchema = z
  .object({
    kind: z.literal('FULL'),
    street: z.string(),
    city: z.string(),
    zipCode: z.string(),
    country: z.string(),
    location: z.object({
      lat: latitudeSchema,
      lng: longitudeSchema,
    }),
  })
  .strict()
export type FullMissionAddress = z.infer<typeof fullMissionAddressSchema>

export const missionAddressViewSchema = z.discriminatedUnion('kind', [
  maskedMissionAddressSchema,
  fullMissionAddressSchema,
])
export type MissionAddressView = z.infer<typeof missionAddressViewSchema>

// =============================================================================
// Mission view (réponses GET / mutations) — applique address policy au runtime
// =============================================================================

/** Vue mission complète (DTO unique pour `/missions/:id`, list, proposals). */
export const missionViewSchema = z
  .object({
    id: uuidSchema,
    missionNumber: z.string(),
    status: MissionStatusSchema,
    serviceType: MissionServiceTypeSchema,

    clientId: uuidSchema,
    /** `null` tant que la mission n'est pas ACCEPTED. */
    prestataireId: uuidSchema.nullable(),

    address: missionAddressViewSchema,

    startAt: isoDateSchema,
    endAt: isoDateSchema,
    timeZone: z.string(),
    isAsap: z.boolean(),

    estimatedPriceCents: z.number().int().nullable(),

    publishedAt: isoDateSchema.nullable(),
    listingExpiresAt: isoDateSchema.nullable(),

    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type MissionView = z.infer<typeof missionViewSchema>

/** Réponse list `/missions` et `/missions/proposed`. */
export const missionListResponseSchema = z
  .object({
    items: z.array(missionViewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
export type MissionListResponse = z.infer<typeof missionListResponseSchema>

/** Query commune pour listings paginés (cursor opaque). */
export const missionListQuerySchema = z
  .object({
    /** Cursor opaque (`mission.id` du dernier item). */
    cursor: uuidSchema.optional(),
    /** Plafond serveur — contrainte CTO Build §3 (pagination obligatoire). */
    limit: z.coerce.number().int().min(1).max(50).default(20),
    status: MissionStatusSchema.optional(),
  })
  .strict()
export type MissionListQuery = z.infer<typeof missionListQuerySchema>

// =============================================================================
// Matching — DTO interne (utilisé par MatchingService, pas exposé tel quel)
// =============================================================================

export const eligiblePrestataireSchema = z
  .object({
    id: uuidSchema,
    approximateDistanceKm: z.number().nonnegative(),
  })
  .strict()
export type EligiblePrestataire = z.infer<typeof eligiblePrestataireSchema>

// =============================================================================
// Codes erreur métier — stables côté client
// =============================================================================

export const missionErrorCodeSchema = z.enum([
  'MISSION_NOT_FOUND',
  'MISSION_FORBIDDEN',
  'MISSION_INVALID_STATE',
  'MISSION_ALREADY_ACCEPTED',
  'MISSION_NOT_ELIGIBLE',
  'MISSION_GEOCODING_FAILED',
  'MISSION_VALIDATION_FAILED',
])
export type MissionErrorCode = z.infer<typeof missionErrorCodeSchema>

export const missionErrorResponseSchema = z
  .object({
    error: missionErrorCodeSchema,
    reason: z.string().max(500).optional(),
  })
  .strict()
export type MissionErrorResponse = z.infer<typeof missionErrorResponseSchema>

// =============================================================================
// MissionEvent — audit minimal (PRD-002 Build, contrainte CTO §1)
// =============================================================================

export const missionEventTypeSchema = z.enum([
  'CREATED',
  'PUBLISHED',
  'MATCHING_DONE',
  'ACCEPTED',
  'EXPIRED',
  'CANCELLED',
  // PRD-003 Ticket 3.2 — paiement carte (PaymentIntent) — audit minimal côté mission.
  'PAYMENT_INTENT_CREATED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELLED',
])
export type MissionEventType = z.infer<typeof missionEventTypeSchema>
