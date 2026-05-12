/**
 * Contrats Zod — Payment + Transfer (PRD-003 Design — livrable 2/5).
 *
 * Source de vérité : `apps/api/prisma/schema.prisma` (Payment, Transfer,
 * PaymentStatus, TransferStatus).
 *
 * ============================================================================
 * SÉPARATION STRICTE Input / Internal / Public — directive CTO PRD-003.
 * ============================================================================
 *
 * - **Input schemas** : ce qui arrive *de l'extérieur* (HTTP body, query).
 *     Suffixe : `xxxInputSchema`.
 * - **Internal schemas** : représentation DB / runtime serveur.
 *     Suffixe : `xxxInternalSchema`. Contiennent les snapshots complets,
 *     les `idempotencyKey`, les références Stripe internes (`transferGroup`).
 *     **JAMAIS exposés sur l'API publique.**
 * - **Public schemas** : DTOs exposés via API HTTP, RBAC-aware.
 *     Préfixe : `publicXxxSchema` ou `clientXxxView` / `prestataireXxxView` /
 *     `adminXxxView` selon le rôle qui lit.
 *
 * Aucun schéma public n'expose (refus explicite CTO) :
 *   - `transferGroup` (Stripe metadata interne)
 *   - `payloadHash` / `last_error` brut (interne)
 *   - `idempotencyKey` (header serveur uniquement)
 *   - `applicationFeeCents` côté client/prestataire (privé business)
 *   - `vatRateSnapshot` brut (interne, MVP)
 */

import { z } from 'zod'

import { PaymentStatusSchema, RefundStatusSchema, TransferStatusSchema } from './enums'
import { serverIdempotencyKeySchema } from './idempotency'
import {
  currencyEurSchema,
  isoDateSchema,
  moneyCentsPositiveSchema,
  moneyCentsSchema,
  uuidSchema,
} from './primitives'

// ============================================================================
// 1) INPUT — body HTTP / headers (ce qui arrive de l'extérieur)
// ============================================================================

/**
 * `POST /payments/intents` — body **CLIENT** crée un PaymentIntent
 * Stripe pour la mission (statut DRAFT/PENDING_PAYMENT).
 *
 * - `missionId` : la mission ciblée (ownership vérifié serveur via RoleGuard).
 * - Pas d'`amount` côté client : calculé serveur à partir du tarif mission
 *   (anti-tamper). Le client ne fixe pas le prix.
 *
 * L'header `Idempotency-Key` est traité séparément par le middleware
 * (`idempotencyKeySchema`).
 */
export const createPaymentIntentInputSchema = z
  .object({
    missionId: uuidSchema,
  })
  .strict()
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentInputSchema>

/**
 * `POST /missions/:id/validate` — body **CLIENT** valide la mission terminée
 * et déclenche capture + transfer Connect (asynchrone).
 *
 * - Pas de body MVP : `:id` route param + JWT identifient tout.
 * - Idempotence : header `Idempotency-Key` (côté serveur, on dérive aussi
 *   une `serverIdempotencyKey` déterministe `capture-mission-{missionId}`).
 */
export const validateMissionPaymentInputSchema = z.object({}).strict()
export type ValidateMissionPaymentInput = z.infer<typeof validateMissionPaymentInputSchema>

/**
 * `POST /payments/:id/refund` — body **ADMIN** rembourse (cas exceptionnel).
 *
 * MVP : refund **intégral uniquement** (revue CTO 2026-05-12 state machines rev2).
 * - `amountCents` **obligatoire** et doit être strictement égal à `Payment.amountCapturedCents`
 *   (validation côté service ; partial refund → 422 `PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED`).
 * - `reason` audit obligatoire (`requested_by_customer`, `fraudulent`, `duplicate`).
 */
export const refundPaymentInputSchema = z
  .object({
    amountCents: moneyCentsPositiveSchema,
    reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent']),
  })
  .strict()
export type RefundPaymentInput = z.infer<typeof refundPaymentInputSchema>

// ============================================================================
// 2) INTERNAL — représentation DB + runtime serveur
// ----------------------------------------------------------------------------
// Ces schémas contiennent les snapshots immutables et les références Stripe
// internes. **Jamais sérialisés tels quels sur l'API publique.**
// ============================================================================

/**
 * Snapshot monétaire immutable posé à la création du PaymentIntent.
 * Lock-in commission : aucun recalcul runtime au moment du Transfer.
 */
export const paymentMonetarySnapshotInternalSchema = z
  .object({
    amountAuthorizedCents: moneyCentsPositiveSchema,
    amountCapturedCents: moneyCentsSchema.nullable(),
    applicationFeeCents: moneyCentsSchema.nullable(),
    providerPayoutCents: moneyCentsSchema.nullable(),
    currency: currencyEurSchema,
    vatRateSnapshot: z.number().nonnegative().max(1).nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.amountCapturedCents !== null &&
      data.amountCapturedCents > data.amountAuthorizedCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountCapturedCents'],
        message: 'amountCapturedCents ne peut pas dépasser amountAuthorizedCents.',
      })
    }
    if (
      data.applicationFeeCents !== null &&
      data.applicationFeeCents > data.amountAuthorizedCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['applicationFeeCents'],
        message: 'applicationFeeCents ne peut pas dépasser amountAuthorizedCents.',
      })
    }
    if (
      data.applicationFeeCents !== null &&
      data.providerPayoutCents !== null &&
      data.providerPayoutCents !== data.amountAuthorizedCents - data.applicationFeeCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerPayoutCents'],
        message:
          'providerPayoutCents doit être exactement (amountAuthorizedCents - applicationFeeCents).',
      })
    }
    if (
      (data.applicationFeeCents === null && data.providerPayoutCents !== null) ||
      (data.applicationFeeCents !== null && data.providerPayoutCents === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerPayoutCents'],
        message:
          'applicationFeeCents et providerPayoutCents doivent être tous deux NULL ou tous deux renseignés.',
      })
    }
  })
export type PaymentMonetarySnapshotInternal = z.infer<typeof paymentMonetarySnapshotInternalSchema>

/**
 * Représentation interne d'un Payment (mapping Prisma).
 * Utilisé par les services pour valider les sorties de Repository.
 */
export const paymentInternalSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    stripePaymentIntentId: z.string().min(1).max(255),
    amountAuthorizedCents: moneyCentsPositiveSchema,
    amountCapturedCents: moneyCentsSchema.nullable(),
    currency: currencyEurSchema,
    applicationFeeCents: moneyCentsSchema.nullable(),
    providerPayoutCents: moneyCentsSchema.nullable(),
    vatRateSnapshot: z.number().nonnegative().max(1).nullable(),
    status: PaymentStatusSchema,
    /** PRD-003 Ticket 3.2 — clé idempotence client (header `Idempotency-Key`). */
    idempotencyKey: z.string().min(8).max(255),
    /** Renseigné côté handler webhook `payment_failed` / `canceled`. */
    failureCode: z.string().max(120).nullable(),
    failureMessage: z.string().max(2_000).nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type PaymentInternal = z.infer<typeof paymentInternalSchema>

/**
 * Représentation interne d'un Transfer Connect (mapping Prisma).
 * **CONTIENT** `idempotencyKey` et `failureReason` bruts — jamais exposé public.
 */
export const transferInternalSchema = z
  .object({
    id: uuidSchema,
    paymentId: uuidSchema,
    stripeTransferId: z.string().min(1).max(255).nullable(),
    amountCents: moneyCentsPositiveSchema,
    currency: currencyEurSchema,
    status: TransferStatusSchema,
    idempotencyKey: serverIdempotencyKeySchema,
    retryCount: z.number().int().nonnegative(),
    lastRetryAt: isoDateSchema.nullable(),
    failureCode: z.string().max(120).nullable(),
    failureReason: z.string().max(2_000).nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type TransferInternal = z.infer<typeof transferInternalSchema>

// ============================================================================
// 3) PUBLIC — DTOs exposés API (RBAC-aware)
// ============================================================================

/**
 * Sous-ensemble des statuts paiement exposables à la *contrepartie* (prestataire)
 * : on masque `REFUNDED` (cas exceptionnel admin) jusqu'à diffusion explicite.
 *
 * Note : le client voit tous les statuts (ce sont *ses* paiements).
 */
export const prestatairePaymentStatusSchema = z.enum(['AUTHORIZED', 'CAPTURED', 'FAILED'])
export type PrestatairePaymentStatus = z.infer<typeof prestatairePaymentStatusSchema>

/**
 * Réponse `POST /payments/intents` — exposée **uniquement au CLIENT**.
 * Contient le `clientSecret` Stripe pour Stripe.js (jamais loggé).
 */
export const createPaymentIntentResponseSchema = z
  .object({
    paymentId: uuidSchema,
    /** Stripe PaymentIntent ID (`pi_...`) — sûr à exposer au client (Stripe.js). */
    stripePaymentIntentId: z.string().min(1).max(255),
    /**
     * `pi_xxx_secret_yyy` — confidentiel mais lié à la session client uniquement.
     * **JAMAIS loggé** (filter Pino + rule sécurité).
     */
    clientSecret: z.string().min(1).max(512),
    amountAuthorizedCents: moneyCentsPositiveSchema,
    currency: currencyEurSchema,
    status: PaymentStatusSchema,
  })
  .strict()
export type CreatePaymentIntentResponse = z.infer<typeof createPaymentIntentResponseSchema>

/**
 * Vue CLIENT d'un Payment — son propre paiement.
 *   - Voit montant + statut + dates.
 *   - **Ne voit pas** : applicationFeeCents (privé business), providerPayoutCents,
 *     vatRateSnapshot, idempotencyKey, transferGroup.
 */
export const clientPaymentViewSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    stripePaymentIntentId: z.string().min(1).max(255),
    status: PaymentStatusSchema,
    amountAuthorizedCents: moneyCentsPositiveSchema,
    amountCapturedCents: moneyCentsSchema.nullable(),
    currency: currencyEurSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type ClientPaymentView = z.infer<typeof clientPaymentViewSchema>

/**
 * Vue PRESTATAIRE d'un Payment — paiement d'une mission qui lui est assignée.
 *   - Voit son montant net potentiel (`providerPayoutCents`) — transparence.
 *   - **Ne voit pas** : `applicationFeeCents` (privé business), `stripePaymentIntentId`
 *     (Stripe interne client), montant client brut redondant masqué.
 *   - Statut limité à `prestatairePaymentStatusSchema` (pas de REFUNDED).
 */
export const prestatairePaymentViewSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    status: prestatairePaymentStatusSchema,
    /** Montant qu'il touchera (lock-in commission). `null` tant que le paiement n'est pas confirmé. */
    providerPayoutCents: moneyCentsSchema.nullable(),
    currency: currencyEurSchema,
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type PrestatairePaymentView = z.infer<typeof prestatairePaymentViewSchema>

/**
 * Vue ADMIN d'un Payment — visibilité totale sauf bytes secrets.
 *   - Tous les champs financiers (snapshots, commission, payout, TVA).
 *   - **Ne voit pas** : `clientSecret`, `transferGroup` (interne Stripe).
 */
export const adminPaymentViewSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    stripePaymentIntentId: z.string().min(1).max(255),
    status: PaymentStatusSchema,
    amountAuthorizedCents: moneyCentsPositiveSchema,
    amountCapturedCents: moneyCentsSchema.nullable(),
    currency: currencyEurSchema,
    applicationFeeCents: moneyCentsSchema.nullable(),
    providerPayoutCents: moneyCentsSchema.nullable(),
    vatRateSnapshot: z.number().nonnegative().max(1).nullable(),
    /** Statut du dernier `Refund` (null si aucun). Admin-only, MVP refund intégral uniquement. */
    latestRefundStatus: RefundStatusSchema.nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type AdminPaymentView = z.infer<typeof adminPaymentViewSchema>

/**
 * Vue PRESTATAIRE d'un Transfer Connect — sa propre rémunération.
 *   - Voit statut simplifié et montant net.
 *   - **Ne voit pas** : `idempotencyKey`, `failureReason` brut (peut contenir
 *     PII / message Stripe brut), `stripeTransferId` (interne).
 */
export const prestataireTransferViewSchema = z
  .object({
    id: uuidSchema,
    paymentId: uuidSchema,
    amountCents: moneyCentsPositiveSchema,
    currency: currencyEurSchema,
    status: TransferStatusSchema,
    /** Présent uniquement si SENT — confirme au prestataire que le virement est parti. */
    sentAt: isoDateSchema.nullable(),
    createdAt: isoDateSchema,
  })
  .strict()
export type PrestataireTransferView = z.infer<typeof prestataireTransferViewSchema>

/**
 * Vue ADMIN d'un Transfer — visibilité complète sauf `stripeTransferId` brut
 * (gardé en `internal` pour traçabilité Stripe).
 */
export const adminTransferViewSchema = z
  .object({
    id: uuidSchema,
    paymentId: uuidSchema,
    stripeTransferId: z.string().min(1).max(255).nullable(),
    amountCents: moneyCentsPositiveSchema,
    currency: currencyEurSchema,
    status: TransferStatusSchema,
    retryCount: z.number().int().nonnegative(),
    lastRetryAt: isoDateSchema.nullable(),
    failureCode: z.string().max(120).nullable(),
    /** Le message brut Stripe peut contenir des éléments compte — admin only. */
    failureReason: z.string().max(2_000).nullable(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
export type AdminTransferView = z.infer<typeof adminTransferViewSchema>

// ============================================================================
// 4) Codes erreur métier — stables côté client (versionnables)
// ============================================================================

export const paymentErrorCodeSchema = z.enum([
  'PAYMENT_NOT_FOUND',
  'PAYMENT_FORBIDDEN',
  'PAYMENT_INVALID_STATE',
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_AMOUNT_REQUIRED',
  'PAYMENT_IDEMPOTENCY_CONFLICT',
  'PAYMENT_MISSING_IDEMPOTENCY_KEY',
  'PAYMENT_3DS_REQUIRED',
  'PAYMENT_CARD_DECLINED',
  'PAYMENT_AUTHORIZATION_EXPIRED',
  'PAYMENT_STRIPE_ERROR',
  'PAYMENT_REFUND_NOT_ALLOWED',
  'PAYMENT_REFUND_BLOCKED_TRANSFER_SENT',
  'PAYMENT_ALREADY_REFUNDED',
  'PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED',
  'MISSION_NOT_FOUND',
  'MISSION_FORBIDDEN',
  'MISSION_NOT_PAYABLE',
  'TRANSFER_NOT_FOUND',
  'TRANSFER_FORBIDDEN',
  'TRANSFER_PROVIDER_NOT_READY',
  'TRANSFER_RETRY_NOT_ALLOWED',
  'DISPUTE_WINDOW_EXPIRED',
])
export type PaymentErrorCode = z.infer<typeof paymentErrorCodeSchema>

export const paymentErrorResponseSchema = z
  .object({
    error: paymentErrorCodeSchema,
    reason: z.string().max(500).optional(),
  })
  .strict()
export type PaymentErrorResponse = z.infer<typeof paymentErrorResponseSchema>

// ============================================================================
// 5) Pagination — query + response (PRD-003 Ticket 3.2)
// ============================================================================

/**
 * Query `GET /v1/payments/mine` (CLIENT). Cursor opaque + plafond serveur strict
 * (contrainte CTO Build §3, alignement `missionListQuerySchema`).
 */
export const clientPaymentListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    status: PaymentStatusSchema.optional(),
  })
  .strict()
export type ClientPaymentListQuery = z.infer<typeof clientPaymentListQuerySchema>

/** Réponse paginée `GET /v1/payments/mine`. */
export const clientPaymentListResponseSchema = z
  .object({
    items: z.array(clientPaymentViewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
export type ClientPaymentListResponse = z.infer<typeof clientPaymentListResponseSchema>

/**
 * Query `GET /v1/admin/payments` (ADMIN). Filtres additionnels par client /
 * mission pour faciliter le support et l'audit.
 */
export const adminPaymentListQuerySchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: PaymentStatusSchema.optional(),
    clientId: uuidSchema.optional(),
    missionId: uuidSchema.optional(),
  })
  .strict()
export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>

/** Réponse paginée `GET /v1/admin/payments`. */
export const adminPaymentListResponseSchema = z
  .object({
    items: z.array(adminPaymentViewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
export type AdminPaymentListResponse = z.infer<typeof adminPaymentListResponseSchema>
