/**
 * Contrats Zod — AutoReleaseJob (PRD-003 livrable 2/5).
 *
 * Source de vérité : `apps/api/prisma/schema.prisma` (AutoReleaseJob,
 * AutoReleaseJobStatus).
 *
 * ============================================================================
 * AutoReleaseJob est un mécanisme **serveur-only** (BullMQ delayed job +
 * cron safety-net). Il n'y a **aucun endpoint public** qui retourne ces
 * jobs au client/prestataire. Seule l'admin les consulte (audit V10).
 * ============================================================================
 */

import { z } from 'zod'

import { AutoReleaseJobStatusSchema } from './enums'
import { serverIdempotencyKeySchema } from './idempotency'
import { isoDateSchema, uuidSchema } from './primitives'

// ============================================================================
// INTERNAL — mapping DB
// ============================================================================

export const autoReleaseJobInternalSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    scheduledFor: isoDateSchema,
    status: AutoReleaseJobStatusSchema,
    bullJobId: z.string().min(1).max(128).nullable(),
    /** Clé idempotence Stripe — déterministe (`auto-release-mission-{missionId}`). */
    idempotencyKey: serverIdempotencyKeySchema.nullable(),
    cancelReason: z.string().max(255).nullable(),
    lastError: z.string().max(4_000).nullable(),
    /** Verrou applicatif (audit Verify V10). */
    lockedAt: isoDateSchema.nullable(),
    lockedBy: z.string().max(255).nullable(),
    startedAt: isoDateSchema.nullable(),
    finishedAt: isoDateSchema.nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const lockedAtSet = data.lockedAt !== null
    const lockedBySet = data.lockedBy !== null
    if (lockedAtSet !== lockedBySet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lockedAt'],
        message: 'lockedAt et lockedBy doivent être tous deux NULL ou tous deux renseignés.',
      })
    }
  })
export type AutoReleaseJobInternal = z.infer<typeof autoReleaseJobInternalSchema>

// ============================================================================
// ADMIN view — dashboard ops
// ============================================================================

export const adminAutoReleaseJobViewSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    scheduledFor: isoDateSchema,
    status: AutoReleaseJobStatusSchema,
    cancelReason: z.string().max(255).nullable(),
    /** Tronqué service-side avant exposition. */
    lastError: z.string().max(500).nullable(),
    lockedAt: isoDateSchema.nullable(),
    lockedBy: z.string().max(255).nullable(),
    startedAt: isoDateSchema.nullable(),
    finishedAt: isoDateSchema.nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type AdminAutoReleaseJobView = z.infer<typeof adminAutoReleaseJobViewSchema>

// ============================================================================
// Codes erreur
// ============================================================================

export const autoReleaseErrorCodeSchema = z.enum([
  'AUTO_RELEASE_JOB_NOT_FOUND',
  'AUTO_RELEASE_JOB_ALREADY_LOCKED',
  'AUTO_RELEASE_JOB_INVALID_STATE',
  'AUTO_RELEASE_JOB_MISSION_DISPUTED',
])
export type AutoReleaseErrorCode = z.infer<typeof autoReleaseErrorCodeSchema>
