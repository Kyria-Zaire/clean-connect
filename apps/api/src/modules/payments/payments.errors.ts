/**
 * PRD-003 — codes d'erreur métier `Payments` (alignés OpenAPI `WebhookErrorCode` /
 * `PaymentErrorCode`). Source de vérité Zod : `@cc/shared-types`.
 *
 * Conventions :
 * - Le `code` est exposé dans le body d'erreur (champ `error`).
 * - Le `reason` complémentaire reste interne sauf cas listés explicitement.
 * - JAMAIS de message Stripe brut dans le `message` exposé (cf. rule securite).
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

export const PAYMENTS_WEBHOOK_ERROR_CODES = {
  INVALID_SIGNATURE: 'WEBHOOK_INVALID_SIGNATURE',
  LIVEMODE_MISMATCH: 'WEBHOOK_LIVEMODE_MISMATCH',
  PAYLOAD_MALFORMED: 'WEBHOOK_PAYLOAD_MALFORMED',
} as const
export type PaymentsWebhookErrorCode =
  (typeof PAYMENTS_WEBHOOK_ERROR_CODES)[keyof typeof PAYMENTS_WEBHOOK_ERROR_CODES]

/** Body uniforme renvoyé pour toute erreur webhook (400). */
export interface WebhookErrorPayload {
  error: PaymentsWebhookErrorCode
  /** Optionnel — détail métier sans Stripe brut. */
  reason?: string
}

export class WebhookInvalidSignatureException extends BadRequestException {
  constructor(reason?: string) {
    const body: WebhookErrorPayload = { error: PAYMENTS_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE }
    if (reason) body.reason = reason
    super(body)
  }
}

export class WebhookLivemodeMismatchException extends BadRequestException {
  constructor(reason: string) {
    const body: WebhookErrorPayload = {
      error: PAYMENTS_WEBHOOK_ERROR_CODES.LIVEMODE_MISMATCH,
      reason,
    }
    super(body)
  }
}

export class WebhookPayloadMalformedException extends BadRequestException {
  constructor(reason?: string) {
    const body: WebhookErrorPayload = { error: PAYMENTS_WEBHOOK_ERROR_CODES.PAYLOAD_MALFORMED }
    if (reason) body.reason = reason
    super(body)
  }
}

/**
 * Module Payments désactivé (`FF_PAYMENTS_ENABLED=false`) — renvoie `503`
 * pour distinguer clairement d'un endpoint inexistant (404) ou en panne (500).
 */
export class PaymentsDisabledException extends ServiceUnavailableException {
  constructor() {
    super({
      error: 'PAYMENTS_DISABLED',
      reason: 'Le module Payments est désactivé sur cet environnement (FF_PAYMENTS_ENABLED=false).',
    })
  }
}

// ---------------------------------------------------------------------------
// PRD-003 Ticket 3.2 — erreurs métier `POST /v1/payments/intent` + listings.
// Codes alignés `paymentErrorCodeSchema` (`@cc/shared-types`).
// ---------------------------------------------------------------------------

export class MissionNotFoundException extends NotFoundException {
  constructor() {
    super({ error: 'MISSION_NOT_FOUND' })
  }
}

export class MissionForbiddenException extends ForbiddenException {
  constructor() {
    super({ error: 'MISSION_FORBIDDEN' })
  }
}

/**
 * Mission n'est pas en `DRAFT` (ou déjà en `PENDING_PAYMENT` via un autre
 * intent vivant) — le client ne doit pas pouvoir initier un PaymentIntent
 * sur une mission déjà publiée / annulée / acceptée.
 */
export class PaymentInvalidStateException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'PAYMENT_INVALID_STATE', reason })
  }
}

/**
 * Replay avec même `Idempotency-Key` mais une `missionId` différente — Stripe
 * interdit (le serveur AUSSI : on garantit que la clé idempotence est liée à
 * une SEULE intention métier).
 */
export class PaymentIdempotencyConflictException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'PAYMENT_IDEMPOTENCY_CONFLICT', reason })
  }
}

export class PaymentMissingIdempotencyKeyException extends BadRequestException {
  constructor(reason?: string) {
    super({
      error: 'PAYMENT_MISSING_IDEMPOTENCY_KEY',
      reason: reason ?? 'Le header `Idempotency-Key` est obligatoire (PRD-003 OpenAPI).',
    })
  }
}

/**
 * Mission sans `estimatedPriceCents` → impossible de créer un PaymentIntent
 * (la mission doit avoir été chiffrée à la création). 422 distinct du 409
 * `PAYMENT_INVALID_STATE` pour clarifier côté client.
 */
export class PaymentAmountRequiredException extends UnprocessableEntityException {
  constructor() {
    super({
      error: 'PAYMENT_AMOUNT_REQUIRED',
      reason:
        "La mission n'a pas de montant chiffré (estimatedPriceCents requis pour le paiement).",
    })
  }
}

/**
 * Erreur générique Stripe lors de la création du PaymentIntent (réseau /
 * configuration / quotas). On expose un code stable mais on **NE log PAS** le
 * message brut Stripe côté réponse API (rule securite + audit Verify V8).
 */
export class PaymentStripeException extends UnprocessableEntityException {
  constructor(reason: string) {
    super({ error: 'PAYMENT_STRIPE_ERROR', reason })
  }
}

// ---------------------------------------------------------------------------
// PRD-003 Ticket 3.4 — erreurs métier capture PaymentIntent
// (POST /v1/missions/:id/validate, auto-release executor).
// Codes alignés `paymentErrorCodeSchema` (`@cc/shared-types`).
// ---------------------------------------------------------------------------

/**
 * Le `Payment` n'est pas en `AUTHORIZED` (par exemple `AUTHORIZATION_PENDING`,
 * `CAPTURED`, `FAILED`, `CANCELLED`, `REFUNDED`). Levé sync par `requestCapture`,
 * 409 pour bien signaler au client (ou à l'auto-release) que l'action n'est
 * pas (ou plus) légitime — l'invariant DB est revérifié systématiquement.
 */
export class PaymentNotCapturableException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'PAYMENT_NOT_CAPTURABLE', reason })
  }
}

/**
 * Stripe a annulé automatiquement l'autorisation après 7 j sans capture
 * (`cancellation_reason='automatic'`). Le Payment est en `CANCELLED` avec
 * `failureCode='authorization_expired'`. Le client doit relancer un nouvel
 * Idempotency-Key (Ticket 3.5 — orchestration retry). 422 distinct du 409
 * `PAYMENT_NOT_CAPTURABLE` pour clarifier côté UI mobile.
 */
export class PaymentAuthorizationExpiredException extends UnprocessableEntityException {
  constructor(reason = "Autorisation Stripe expirée (7 jours sans capture). Relancez un paiement.") {
    super({ error: 'PAYMENT_AUTHORIZATION_EXPIRED', reason })
  }
}
