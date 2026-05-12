/**
 * Contrats Zod — Mission (PRD-002 Design).
 * Alignés sur `apps/api/prisma/schema.prisma` (enums + champs métier).
 */

import { z } from 'zod'

import { MissionServiceTypeSchema } from './enums'
import { addressSchema, isoDateSchema } from './primitives'

/** Corps `POST /missions` (brouillon) — Build branchera sur NestJS + service ASAP. */
export const createMissionDraftBodySchema = z
  .object({
    serviceType: MissionServiceTypeSchema,
    address: addressSchema,
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

/** Réponse liste matching — DTO public (pas de PII sensible). */
export const eligiblePrestataireSchema = z
  .object({
    id: z.string().uuid(),
    approximateDistanceKm: z.number().nonnegative(),
  })
  .strict()

export type EligiblePrestataire = z.infer<typeof eligiblePrestataireSchema>

/** Adresse masquée pour prestataire avant acceptation (RGPD — PRD-002 Q6). */
export const maskedMissionAddressSchema = z
  .object({
    kind: z.literal('MASKED'),
    city: z.string(),
    partialZipCode: z.string(),
    approximateDistanceKm: z.number().nonnegative(),
  })
  .strict()

export type MaskedMissionAddress = z.infer<typeof maskedMissionAddressSchema>

export const fullMissionAddressSchema = z
  .object({
    kind: z.literal('FULL'),
    street: z.string(),
    city: z.string(),
    zipCode: z.string(),
    country: z.string(),
    location: z.object({
      lat: z.number(),
      lng: z.number(),
    }),
  })
  .strict()

export type FullMissionAddress = z.infer<typeof fullMissionAddressSchema>

export const missionAddressViewSchema = z.discriminatedUnion('kind', [
  maskedMissionAddressSchema,
  fullMissionAddressSchema,
])

export type MissionAddressView = z.infer<typeof missionAddressViewSchema>
