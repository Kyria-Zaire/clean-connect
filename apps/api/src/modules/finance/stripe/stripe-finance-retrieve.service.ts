/**
 * PRD-004 Ticket 4.5 — `StripeFinanceRetrieveService`.
 *
 * Wrapper read-only autour du SDK Stripe pour le monitoring finance.
 *
 * Règles dures :
 *  - **Read-only** — aucun `create` / `update` / `capture` / `refund` ici.
 *  - **Timeout réseau** — `AbortSignal.timeout(10_000)` par appel (rule
 *    integrate-external-service : timeout obligatoire).
 *  - **Rate limit applicatif** — max **25 req/s** agrégées sur ce service
 *    (PRD-004 §4.15.11 + ADR-018 §2.7). Implémentation : token bucket simple
 *    (pas de dépendance `p-limit` ajoutée au monorepo).
 *  - **Instrumentation** — chaque appel passe par `StripeMetricsTracker.time`
 *    (ADR-014 A3-bis).
 *
 * Les méthodes retournent `null` si l'objet Stripe n'existe pas (`404`) —
 * le caller finance traduit en `MISSING_STRIPE` / mismatch approprié.
 */

import { Inject, Injectable } from '@nestjs/common'
import Stripe from 'stripe'

import { StripeMetricsTracker } from '../../observability/metrics/stripe-metrics.tracker'
import { STRIPE_CLIENT_TOKEN } from '../../payments/stripe/stripe.client'

const STRIPE_RETRIEVE_TIMEOUT_MS = 10_000
const STRIPE_FINANCE_MAX_RPS = 25

@Injectable()
export class StripeFinanceRetrieveService {
  private tokens = STRIPE_FINANCE_MAX_RPS
  private lastRefillMs = Date.now()

  constructor(
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe: Stripe,
    private readonly stripeMetrics: StripeMetricsTracker,
  ) {}

  private async throttle(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastRefillMs
    if (elapsed >= 1000) {
      const buckets = Math.floor(elapsed / 1000)
      this.tokens = Math.min(STRIPE_FINANCE_MAX_RPS, this.tokens + buckets * STRIPE_FINANCE_MAX_RPS)
      this.lastRefillMs += buckets * 1000
    }
    if (this.tokens > 0) {
      this.tokens -= 1
      return
    }
    // Attendre jusqu'au prochain refill 1s (borne simple).
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (now - this.lastRefillMs))))
    return this.throttle()
  }

  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent | null> {
    await this.throttle()
    return this.stripeMetrics.time('payment_intents.retrieve', async () => {
      try {
        return await withTimeout(
          this.stripe.paymentIntents.retrieve(id),
          STRIPE_RETRIEVE_TIMEOUT_MS,
        )
      } catch (err) {
        if (isStripeStatusCode(err, 404)) return null
        throw err
      }
    })
  }

  async retrieveTransfer(id: string): Promise<Stripe.Transfer | null> {
    await this.throttle()
    return this.stripeMetrics.time('transfers.retrieve', async () => {
      try {
        return await withTimeout(this.stripe.transfers.retrieve(id), STRIPE_RETRIEVE_TIMEOUT_MS)
      } catch (err) {
        if (isStripeStatusCode(err, 404)) return null
        throw err
      }
    })
  }

  async retrieveRefund(id: string): Promise<Stripe.Refund | null> {
    await this.throttle()
    return this.stripeMetrics.time('refunds.retrieve', async () => {
      try {
        return await withTimeout(this.stripe.refunds.retrieve(id), STRIPE_RETRIEVE_TIMEOUT_MS)
      } catch (err) {
        if (isStripeStatusCode(err, 404)) return null
        throw err
      }
    })
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise

  return new Promise<T>((resolve, reject) => {
    const t = globalThis.setTimeout(() => {
      reject(new Error('stripe_finance_retrieve_timeout'))
    }, timeoutMs)

    promise
      .then(resolve, reject)
      .finally(() => {
        globalThis.clearTimeout(t)
      })
  })
}

function isStripeStatusCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== 'object') return false
  const statusCode = (err as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' && statusCode === code
}
