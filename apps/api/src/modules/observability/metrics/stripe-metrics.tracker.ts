/**
 * StripeMetricsTracker — instrumentation des appels SDK Stripe.
 * Source de vérité : cahier CTO PRD-004 §A3-bis.
 *
 * Trois métriques alimentées par chaque appel :
 *  - `cleanconnect_stripe_api_calls_total{operation, status}` — counter
 *  - `cleanconnect_stripe_api_failures_total{operation, status}` — counter
 *    (subset de calls_total avec `status != success`)
 *  - `cleanconnect_stripe_api_duration_seconds{operation, status}` — histogram
 *
 * **Labels autorisés uniquement** : `operation` + `status`.
 * `operation` = `payment_intents.create`, `transfers.create`, ... (whitelist
 * bornée, cardinalité ≤ 10). `status` ∈ STATUS_VALUES (cardinalité ≤ 10).
 *
 * **Aucun label PII** : pas de `userId`, `missionId`, `paymentIntentId`,
 * `stripeAccountId`, `customerId`, `email`. Si un appel ajoute un context
 * métier, il reste dans les logs (Pino redactor) — pas dans Prometheus.
 *
 * Helper async (`time`) — pour 95 % des appels Stripe (création/retrieve).
 * Helper sync (`timeSync`) — pour `webhooks.constructEvent` qui est sync.
 *
 * Classification d'erreur via `classifyStripeError` : on lit le nom de la
 * classe Stripe (`StripeRateLimitError`, etc.) plutôt que le message brut,
 * pour borner `status` à une whitelist stable.
 */

import { Injectable } from '@nestjs/common'

import { MetricsService } from './metrics.service'

/**
 * Liste exhaustive des opérations Stripe instrumentées. Toute addition ici
 * doit être justifiée + documentée (cf. ADR-014 §2.5 cardinalité).
 *
 * Justification : labels `operation` = clé de bucketing principale pour les
 * alertes par fonctionnalité (capture, refund, transfer, webhook signature).
 */
export const STRIPE_OPERATIONS = [
  'payment_intents.create',
  'payment_intents.capture',
  'payment_intents.retrieve',
  'refunds.create',
  'refunds.retrieve',
  'transfers.create',
  'transfers.retrieve',
  'events.retrieve',
  'webhooks.construct_event',
] as const

export type StripeOperation = (typeof STRIPE_OPERATIONS)[number]

/**
 * Whitelist `status` — bornée pour éviter l'explosion de cardinalité.
 * Tout statut inconnu retombe sur `'unknown'`.
 */
export const STRIPE_STATUSES = [
  'success',
  'invalid_signature',
  'invalid_request',
  'authentication',
  'permission',
  'rate_limited',
  'connection',
  'card_error',
  'api_error',
  'unknown',
] as const

export type StripeStatus = (typeof STRIPE_STATUSES)[number]

@Injectable()
export class StripeMetricsTracker {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Wrap un appel SDK Stripe async. Mesure la latence, incrémente les
   * counters et propage l'erreur sans masquage (rule senior-dev — pas de
   * catch silencieux).
   */
  async time<T>(operation: StripeOperation, fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint()
    try {
      const result = await fn()
      this.record(operation, 'success', start)
      return result
    } catch (err) {
      const status = classifyStripeError(err)
      this.record(operation, status, start)
      this.metrics.stripeApiFailuresTotal.inc({ operation, status })
      throw err
    }
  }

  /**
   * Variante synchrone — utilisée par `webhooks.constructEvent` qui est sync
   * (HMAC uniquement, pas d'I/O).
   */
  timeSync<T>(operation: StripeOperation, fn: () => T): T {
    const start = process.hrtime.bigint()
    try {
      const result = fn()
      this.record(operation, 'success', start)
      return result
    } catch (err) {
      const status = classifyStripeError(err)
      this.record(operation, status, start)
      this.metrics.stripeApiFailuresTotal.inc({ operation, status })
      throw err
    }
  }

  private record(operation: StripeOperation, status: StripeStatus, start: bigint): void {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000
    this.metrics.stripeApiCallsTotal.inc({ operation, status })
    this.metrics.stripeApiDurationSeconds.observe({ operation, status }, durationSeconds)
  }
}

/**
 * Classifie une erreur Stripe en `StripeStatus` borné. On regarde `err.name`
 * (et `err.type` en fallback) plutôt que le message brut — la regex sur le
 * message est fragile et risque PII.
 *
 * Mapping aligné sur la hiérarchie d'erreurs documentée du SDK Stripe Node
 * (`StripeError` → sous-classes nommées). Exposé pour les tests.
 */
export function classifyStripeError(err: unknown): StripeStatus {
  if (!(err instanceof Error)) return 'unknown'
  const name = err.name
  // Lecture défensive de `type` — Stripe SDK l'expose sur les sous-classes
  // mais TS ne le voit pas via `Error`. Pas de cast `as Stripe.errors.*` ici
  // pour éviter un import direct au SDK (découplage).
  const stripeType = (err as { type?: unknown }).type
  const candidate = typeof stripeType === 'string' ? stripeType : name

  switch (candidate) {
    case 'StripeSignatureVerificationError':
    case 'signature_verification_error':
      return 'invalid_signature'
    case 'StripeInvalidRequestError':
    case 'invalid_request_error':
      return 'invalid_request'
    case 'StripeAuthenticationError':
    case 'authentication_error':
      return 'authentication'
    case 'StripePermissionError':
    case 'StripeIdempotencyError':
      return 'permission'
    case 'StripeRateLimitError':
    case 'rate_limit_error':
      return 'rate_limited'
    case 'StripeConnectionError':
      return 'connection'
    case 'StripeCardError':
    case 'card_error':
      return 'card_error'
    case 'StripeAPIError':
    case 'api_error':
      return 'api_error'
    default:
      return 'unknown'
  }
}
