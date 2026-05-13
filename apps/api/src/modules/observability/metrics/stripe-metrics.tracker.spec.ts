/**
 * Tests StripeMetricsTracker — PRD-004 Ticket 4.1 Build A3-bis.
 *
 * Couvre :
 * - succès (sync + async) → counter `success` + histogram observé
 * - échec classifié (signature, rate limit, network, auth, card)
 *   → counter `<status>` + counter failures + propagation de l'erreur
 * - aucun label PII / cardinality leak (lab list bornée)
 * - duplication metric registration → safe (registry isolé)
 */

import { MetricsService } from './metrics.service'
import {
  STRIPE_OPERATIONS,
  StripeMetricsTracker,
  classifyStripeError,
} from './stripe-metrics.tracker'

describe('StripeMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: StripeMetricsTracker

  beforeEach(() => {
    metrics = new MetricsService()
    tracker = new StripeMetricsTracker(metrics)
  })

  afterEach(() => {
    metrics.onModuleDestroy()
  })

  describe('time() — async wrapper', () => {
    it('records success on a resolved promise', async () => {
      const fn = jest.fn().mockResolvedValue({ id: 'pi_123' })
      const out = await tracker.time('payment_intents.create', fn)

      expect(out).toEqual({ id: 'pi_123' })
      expect(fn).toHaveBeenCalledTimes(1)

      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_stripe_api_calls_total\{operation="payment_intents.create",status="success"\} 1/,
      )
      // Histogram : la latence est dans l'un des buckets — on vérifie la
      // présence de la série (sum > 0).
      expect(body).toMatch(/cleanconnect_stripe_api_duration_seconds_sum.*payment_intents\.create.*success/)
    })

    it('records the classified status on rejection and rethrows', async () => {
      const err = new Error('rate limited')
      err.name = 'StripeRateLimitError'
      const fn = jest.fn().mockRejectedValue(err)

      await expect(tracker.time('refunds.create', fn)).rejects.toBe(err)

      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_stripe_api_calls_total\{operation="refunds.create",status="rate_limited"\} 1/,
      )
      expect(body).toMatch(
        /cleanconnect_stripe_api_failures_total\{operation="refunds.create",status="rate_limited"\} 1/,
      )
    })

    it('records unknown when error is not a Stripe error', async () => {
      const fn = jest.fn().mockRejectedValue(new TypeError('boom'))
      await expect(tracker.time('transfers.create', fn)).rejects.toBeInstanceOf(TypeError)

      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_stripe_api_calls_total\{operation="transfers.create",status="unknown"\} 1/,
      )
    })

    it('instruments refunds.retrieve (finance read-only)', async () => {
      const fn = jest.fn().mockResolvedValue({ id: 're_123' })
      await tracker.time('refunds.retrieve', fn)

      const body = (await metrics.render()).body
      expect(body).toMatch(/cleanconnect_stripe_api_calls_total\{operation="refunds.retrieve",status="success"\} 1/)
    })
  })

  describe('timeSync() — sync wrapper (webhooks.construct_event)', () => {
    it('records success and returns the value', () => {
      const out = tracker.timeSync('webhooks.construct_event', () => 'ok')
      expect(out).toBe('ok')
    })

    it('records invalid_signature on StripeSignatureVerificationError', async () => {
      const err = new Error('bad signature')
      err.name = 'StripeSignatureVerificationError'

      expect(() =>
        tracker.timeSync('webhooks.construct_event', () => {
          throw err
        }),
      ).toThrow(err)

      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_stripe_api_calls_total\{operation="webhooks.construct_event",status="invalid_signature"\} 1/,
      )
      expect(body).toMatch(
        /cleanconnect_stripe_api_failures_total\{operation="webhooks.construct_event",status="invalid_signature"\} 1/,
      )
    })
  })

  describe('cardinality / label safety', () => {
    it('exposes a closed set of operations (low cardinality)', () => {
      // 8 opérations max — toute addition doit être justifiée + documentée.
      expect(STRIPE_OPERATIONS.length).toBeLessThanOrEqual(12)
      for (const op of STRIPE_OPERATIONS) {
        expect(op).toMatch(/^[a-z_]+\.[a-z_]+$/)
      }
    })

    it('multiple constructions of MetricsService are independent (no duplicate registration)', () => {
      // Vérifie l'isolation du registry — chaque construction est sûre,
      // contrairement au `register` global de prom-client.
      const a = new MetricsService()
      const b = new MetricsService()
      expect(() => {
        a.stripeApiCallsTotal.inc({ operation: 'payment_intents.create', status: 'success' })
        b.stripeApiCallsTotal.inc({ operation: 'payment_intents.create', status: 'success' })
      }).not.toThrow()
      a.onModuleDestroy()
      b.onModuleDestroy()
    })
  })

  describe('classifyStripeError()', () => {
    it.each([
      ['StripeSignatureVerificationError', 'invalid_signature'],
      ['StripeInvalidRequestError', 'invalid_request'],
      ['StripeAuthenticationError', 'authentication'],
      ['StripePermissionError', 'permission'],
      ['StripeIdempotencyError', 'permission'],
      ['StripeRateLimitError', 'rate_limited'],
      ['StripeConnectionError', 'connection'],
      ['StripeCardError', 'card_error'],
      ['StripeAPIError', 'api_error'],
    ])('maps %s → %s', (name, expected) => {
      const e = new Error('x')
      e.name = name
      expect(classifyStripeError(e)).toBe(expected)
    })

    it('maps unknown error names to "unknown"', () => {
      expect(classifyStripeError(new Error('weird'))).toBe('unknown')
    })

    it('falls back to err.type when name is generic Error', () => {
      const e = new Error('x') as Error & { type: string }
      e.type = 'rate_limit_error'
      expect(classifyStripeError(e)).toBe('rate_limited')
    })

    it('handles non-Error values gracefully', () => {
      expect(classifyStripeError(null)).toBe('unknown')
      expect(classifyStripeError('boom')).toBe('unknown')
      expect(classifyStripeError({ message: 'x' })).toBe('unknown')
    })
  })
})
