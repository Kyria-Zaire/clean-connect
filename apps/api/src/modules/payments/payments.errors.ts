/**
 * PRD-003 — codes d'erreur métier `Payments` (alignés OpenAPI `WebhookErrorCode` /
 * `PaymentErrorCode`). Source de vérité Zod : `@cc/shared-types`.
 *
 * Conventions :
 * - Le `code` est exposé dans le body d'erreur (champ `error`).
 * - Le `reason` complémentaire reste interne sauf cas listés explicitement.
 * - JAMAIS de message Stripe brut dans le `message` exposé (cf. rule securite).
 */

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'

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
