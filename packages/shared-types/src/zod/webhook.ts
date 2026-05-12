/**
 * Contrats Zod — StripeWebhookEvent + Domain events (PRD-003 livrable 2/5).
 *
 * Source de vérité : `apps/api/prisma/schema.prisma` (StripeWebhookEvent,
 * WebhookDeadLetter, StripeWebhookProcessingStatus, WebhookDeadLetterSource).
 *
 * ============================================================================
 * 3 NIVEAUX OBLIGATOIRES — directive CTO PRD-003 livrable 2/5
 * ============================================================================
 *
 *   Niveau 1 — Stripe raw payload          (`stripeWebhookRawSchema`)
 *      ↓ vérification HMAC + idempotence DB
 *   Niveau 2 — Normalized internal event   (`stripeWebhookEventInternalSchema`)
 *      ↓ projection métier
 *   Niveau 3 — Domain event CleanConnect   (`domainEventSchema` — discriminé)
 *
 * **Aucun niveau n'est exposé publiquement** (les webhooks sont serveur-only).
 * Les `adminWebhookEventViewSchema` existent pour le dashboard admin (audit/DLQ),
 * mais sans le payload brut (`stripeRawPayload` interdit).
 */

import { z } from 'zod'

import { StripeWebhookProcessingStatusSchema, WebhookDeadLetterSourceSchema } from './enums'
import {
  isoDateSchema,
  moneyCentsPositiveSchema,
  moneyCentsSchema,
  sha256HexSchema,
  uuidSchema,
} from './primitives'

// ============================================================================
// 1) NIVEAU 1 — Stripe raw payload (post-HMAC, pré-désérialisation métier)
// ----------------------------------------------------------------------------
// Validation minimale après `stripe.webhooks.constructEvent()` : on s'assure
// que la forme correspond à un Stripe Event v2025-02-24.acacia.
// On ne valide PAS `event.data.object` ici (dépend du `type`).
// ============================================================================

/** Types Stripe écoutés en MVP (ADR-008 / ADR-011). */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  'account.updated',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'transfer.created',
  'transfer.paid',
  'transfer.reversed',
  'transfer.failed',
] as const
export type StripeWebhookEventType = (typeof STRIPE_WEBHOOK_EVENT_TYPES)[number]

export const stripeWebhookEventTypeSchema = z.enum(STRIPE_WEBHOOK_EVENT_TYPES)

/**
 * Niveau 1 — Stripe raw payload (forme générique, post-HMAC).
 *
 * **Ne pas** valider `data.object` ici : la forme dépend du `type` (PaymentIntent,
 * Charge, Transfer, Account, etc.). La validation détaillée se fait en Niveau 2
 * via discrimination par `type`.
 */
export const stripeWebhookRawSchema = z
  .object({
    id: z.string().min(1).max(255).regex(/^evt_/u, 'Stripe event ID doit commencer par `evt_`.'),
    object: z.literal('event'),
    type: stripeWebhookEventTypeSchema,
    livemode: z.boolean(),
    api_version: z.string().min(1).max(40),
    created: z.number().int().positive(),
    data: z
      .object({
        object: z.record(z.unknown()),
        previous_attributes: z.record(z.unknown()).optional(),
      })
      .strict(),
    request: z
      .object({
        id: z.string().nullable(),
        idempotency_key: z.string().nullable(),
      })
      .nullable(),
    pending_webhooks: z.number().int().nonnegative(),
  })
  .passthrough() // Stripe ajoute des champs au fil des versions API — on tolère sans casser.
export type StripeWebhookRaw = z.infer<typeof stripeWebhookRawSchema>

// ============================================================================
// 2) NIVEAU 2 — Normalized internal event (mapping DB `stripe_webhook_events`)
// ----------------------------------------------------------------------------
// Représentation persistée après HMAC OK + dédup DB. Contient `payloadHash`,
// `processingStatus`, etc. **Aucun bout exposé publiquement.**
// ============================================================================

export const stripeWebhookEventInternalSchema = z
  .object({
    stripeEventId: z.string().min(1).max(255).regex(/^evt_/u),
    type: stripeWebhookEventTypeSchema,
    payloadHash: sha256HexSchema,
    livemode: z.boolean(),
    processingStatus: StripeWebhookProcessingStatusSchema,
    createdAt: isoDateSchema,
    processingStartedAt: isoDateSchema.nullable(),
    processedAt: isoDateSchema.nullable(),
    lastError: z.string().max(4_000).nullable(),
  })
  .strict()
export type StripeWebhookEventInternal = z.infer<typeof stripeWebhookEventInternalSchema>

/**
 * `WebhookDeadLetter` — INTERNAL. Capture les échecs (5 retries puis DLQ).
 * Le `rawPayload` est conservé pour replay manuel admin, **jamais exposé public**.
 */
export const webhookDeadLetterInternalSchema = z
  .object({
    id: uuidSchema,
    source: WebhookDeadLetterSourceSchema,
    /** Référence stripeEventId quand source=STRIPE. */
    sourceEventId: z.string().min(1).max(255).nullable(),
    payloadHash: sha256HexSchema,
    /** Payload sérialisé JSON — INTERNAL ONLY. */
    rawPayload: z.string(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().max(4_000),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type WebhookDeadLetterInternal = z.infer<typeof webhookDeadLetterInternalSchema>

// ============================================================================
// 3) NIVEAU 3 — Domain events CleanConnect (discriminé par `kind`)
// ----------------------------------------------------------------------------
// Évents métier déduits d'un webhook après normalisation. Consommés par les
// processors BullMQ (state machine Payment + Mission). Internal only.
// ============================================================================

const baseDomainEventSchema = z.object({
  /** Référence interne au StripeWebhookEvent qui a produit ce domain event. */
  sourceEventId: z.string().min(1).max(255),
  occurredAt: isoDateSchema,
})

export const paymentAuthorizedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('PaymentAuthorized'),
  paymentId: uuidSchema,
  missionId: uuidSchema,
  stripePaymentIntentId: z.string().min(1).max(255),
  amountAuthorizedCents: moneyCentsPositiveSchema,
})

export const paymentCapturedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('PaymentCaptured'),
  paymentId: uuidSchema,
  missionId: uuidSchema,
  amountCapturedCents: moneyCentsPositiveSchema,
})

export const paymentFailedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('PaymentFailed'),
  paymentId: uuidSchema,
  missionId: uuidSchema,
  failureCode: z.string().max(120).nullable(),
  failureMessage: z.string().max(2_000).nullable(),
})

export const paymentRefundedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('PaymentRefunded'),
  paymentId: uuidSchema,
  missionId: uuidSchema,
  amountRefundedCents: moneyCentsPositiveSchema,
})

export const transferSentDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('TransferSent'),
  transferId: uuidSchema,
  paymentId: uuidSchema,
  amountCents: moneyCentsPositiveSchema,
  stripeTransferId: z.string().min(1).max(255),
})

export const transferFailedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('TransferFailed'),
  transferId: uuidSchema,
  paymentId: uuidSchema,
  failureCode: z.string().max(120).nullable(),
  failureMessage: z.string().max(2_000).nullable(),
})

export const transferReversedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('TransferReversed'),
  transferId: uuidSchema,
  paymentId: uuidSchema,
  /** Montant repris (peut être partiel selon Stripe). */
  amountReversedCents: moneyCentsPositiveSchema,
})

export const providerAccountUpdatedDomainEventSchema = baseDomainEventSchema.extend({
  kind: z.literal('ProviderAccountUpdated'),
  userId: uuidSchema,
  stripeAccountId: z.string().min(1).max(255),
  chargesEnabled: z.boolean(),
  transfersEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  requirementsDue: z.array(z.string().max(120)),
})

export const domainEventSchema = z.discriminatedUnion('kind', [
  paymentAuthorizedDomainEventSchema,
  paymentCapturedDomainEventSchema,
  paymentFailedDomainEventSchema,
  paymentRefundedDomainEventSchema,
  transferSentDomainEventSchema,
  transferFailedDomainEventSchema,
  transferReversedDomainEventSchema,
  providerAccountUpdatedDomainEventSchema,
])
export type DomainEvent = z.infer<typeof domainEventSchema>

// ============================================================================
// 4) ADMIN view — pour dashboard `/admin/webhooks` (audit/DLQ)
// ----------------------------------------------------------------------------
// **Ne contient PAS `rawPayload`** (refus CTO : webhook payload brut interdit
// en sortie publique — même admin → consultation via console DB / job admin
// dédié séparé).
// ============================================================================

export const adminStripeWebhookEventViewSchema = z
  .object({
    stripeEventId: z.string().min(1).max(255),
    type: stripeWebhookEventTypeSchema,
    livemode: z.boolean(),
    processingStatus: StripeWebhookProcessingStatusSchema,
    createdAt: isoDateSchema,
    processingStartedAt: isoDateSchema.nullable(),
    processedAt: isoDateSchema.nullable(),
    /** Tronqué côté service pour éviter fuite de message Stripe brut. */
    lastError: z.string().max(500).nullable(),
  })
  .strict()
export type AdminStripeWebhookEventView = z.infer<typeof adminStripeWebhookEventViewSchema>

export const adminWebhookDeadLetterViewSchema = z
  .object({
    id: uuidSchema,
    source: WebhookDeadLetterSourceSchema,
    sourceEventId: z.string().min(1).max(255).nullable(),
    attempts: z.number().int().nonnegative(),
    /** Tronqué côté service. */
    lastError: z.string().max(500),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type AdminWebhookDeadLetterView = z.infer<typeof adminWebhookDeadLetterViewSchema>

// ============================================================================
// 5) Codes erreur webhook
// ============================================================================

export const webhookErrorCodeSchema = z.enum([
  'WEBHOOK_INVALID_SIGNATURE',
  'WEBHOOK_LIVEMODE_MISMATCH',
  'WEBHOOK_ALREADY_PROCESSED',
  'WEBHOOK_PROCESSING_LOCKED',
  'WEBHOOK_PAYLOAD_MALFORMED',
  'WEBHOOK_PROCESSING_FAILED',
  // PRD-003 Ticket 3.1 — 503 quand FF_PAYMENTS_ENABLED=false.
  'PAYMENTS_DISABLED',
])
export type WebhookErrorCode = z.infer<typeof webhookErrorCodeSchema>

/**
 * Body de la réponse `202` du webhook Stripe (PRD-003 Ticket 3.1).
 * Aligné sur le contrat OpenAPI `WebhookAccepted202Body`.
 */
export const webhookAcceptedResponseSchema = z
  .object({
    accepted: z.literal(true),
    idempotent: z.boolean(),
    eventId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^evt_/u, 'eventId doit commencer par evt_ (PRD-003 Ticket 3.1).'),
  })
  .strict()
export type WebhookAcceptedResponse = z.infer<typeof webhookAcceptedResponseSchema>

// ============================================================================
// 6) Sanity export — silence noUnusedLocals si moneyCentsSchema importé non utilisé
// ----------------------------------------------------------------------------
// `moneyCentsSchema` peut servir à des handlers admin future (montants ≥ 0
// pour refund partiel, etc.) — on ré-exporte pour stabilité d'API.
// ============================================================================

export { moneyCentsSchema as webhookMoneyCentsSchema }
