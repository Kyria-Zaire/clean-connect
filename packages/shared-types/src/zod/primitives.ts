/**
 * Schémas Zod primitifs réutilisables (UUID, dates, coordonnées GPS, money, etc.).
 */

import { z } from 'zod'

export const uuidSchema = z.string().uuid('UUID v4 attendu')
export type UUID = z.infer<typeof uuidSchema>

export const isoDateSchema = z.string().datetime({ offset: true })
export type ISODate = z.infer<typeof isoDateSchema>

export const emailSchema = z.string().email().toLowerCase().trim().max(320)
export type Email = z.infer<typeof emailSchema>

export const passwordSchema = z
  .string()
  .min(12, 'Minimum 12 caractères.')
  .max(128, 'Maximum 128 caractères.')

export const latitudeSchema = z.number().min(-90).max(90)
export const longitudeSchema = z.number().min(-180).max(180)

/** Précision GPS en mètres — borné à 10 km (au-delà = capteur défaillant). */
export const gpsAccuracyMetersSchema = z.number().int().nonnegative().max(10_000)
export type GpsAccuracyMeters = z.infer<typeof gpsAccuracyMetersSchema>

export const geoPointSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
})
export type GeoPoint = z.infer<typeof geoPointSchema>

export const addressSchema = z.object({
  street: z.string().min(1).max(255),
  city: z.string().min(1).max(120),
  zipCode: z
    .string()
    .regex(/^\d{5}$/u, 'Code postal FR (5 chiffres)')
    .max(10),
  country: z.string().length(2).default('FR'),
  location: geoPointSchema,
})
export type AddressInput = z.infer<typeof addressSchema>

// ============================================================================
// Money — PRD-003 Sprint 3 (CTO contraintes Zod livrable 2/5)
// ----------------------------------------------------------------------------
// **Règle absolue** : tous les montants en *integer cents* (ADR-002).
// Aucune route, aucun DTO public n'accepte un `number` libre — uniquement
// `moneyCentsSchema` (≥0) ou `moneyCentsPositiveSchema` (>0).
// Plafond raisonnable : 50 000 € (= 5_000_000 cents) pour stopper les abus
// d'entrée bien avant que Stripe ne refuse.
// ============================================================================

export const MONEY_CENTS_MAX = 50_000_00 as const

/** Montant en centimes — entier, **≥ 0**, plafonné à 50 000 €. */
export const moneyCentsSchema = z
  .number()
  .int('Le montant doit être un entier (centimes).')
  .nonnegative('Le montant doit être ≥ 0 centimes.')
  .max(MONEY_CENTS_MAX, `Le montant ne peut pas dépasser ${MONEY_CENTS_MAX} centimes (50 000 €).`)
export type MoneyCents = z.infer<typeof moneyCentsSchema>

/** Montant en centimes strictement positif — paiement / transfer / commission. */
export const moneyCentsPositiveSchema = moneyCentsSchema.refine((v) => v > 0, {
  message: 'Le montant doit être strictement positif.',
})
export type MoneyCentsPositive = z.infer<typeof moneyCentsPositiveSchema>

/** Devise — EUR uniquement MVP (décision CTO Q11). Lowercase = convention Stripe. */
export const currencyEurSchema = z.literal('eur')
export type CurrencyEur = z.infer<typeof currencyEurSchema>

// ============================================================================
// Hashes & checksums — utilisés en interne (PhotoUploadSession.tokenDigest,
// Photo.checksumSha256, StripeWebhookEvent.payloadHash).
// ============================================================================

/** SHA-256 hex (64 chars lowercase) — usage interne uniquement (jamais exposé public). */
export const sha256HexSchema = z
  .string()
  .length(64, 'SHA-256 hex doit faire exactement 64 caractères.')
  .regex(/^[0-9a-f]{64}$/u, 'SHA-256 hex : caractères [0-9a-f] uniquement (lowercase).')
export type Sha256Hex = z.infer<typeof sha256HexSchema>
