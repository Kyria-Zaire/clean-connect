/**
 * Tests WebhookMetricsTracker — PRD-004 Ticket 4.1 Build A3-bis.
 *
 * Couvre :
 * - les 4 outcomes (accepted, rejected, replayed, failed) sont émis
 * - `_failures_total` est incrémenté UNIQUEMENT pour outcome ∈ {rejected, failed}
 * - normalisation event_type (whitelist + pattern + cardinality fallback)
 * - histogram observe vérifié via render()
 */

import { MetricsService } from './metrics.service'
import {
  KNOWN_STRIPE_EVENT_TYPES,
  WebhookMetricsTracker,
  normalizeEventType,
} from './webhook-metrics.tracker'

describe('WebhookMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: WebhookMetricsTracker

  beforeEach(() => {
    metrics = new MetricsService()
    tracker = new WebhookMetricsTracker(metrics)
  })

  afterEach(() => {
    metrics.onModuleDestroy()
  })

  describe('observe() / recordOutcome()', () => {
    it('increments processing_total and observes duration for accepted', async () => {
      tracker.observe('payment_intent.succeeded', 'accepted', 0.123)
      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_webhook_processing_total\{event_type="payment_intent.succeeded",outcome="accepted"\} 1/,
      )
      expect(body).toMatch(
        /cleanconnect_webhook_processing_duration_seconds_sum.*payment_intent\.succeeded.*accepted/,
      )
      // failures_total ne doit PAS bouger sur accepted.
      expect(body).not.toMatch(
        /cleanconnect_webhook_processing_failures_total\{event_type="payment_intent.succeeded".*\} [1-9]/,
      )
    })

    it('increments failures_total for outcome=rejected', async () => {
      tracker.recordOutcome('payment_intent.succeeded', 'rejected')
      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_webhook_processing_total\{event_type="payment_intent.succeeded",outcome="rejected"\} 1/,
      )
      expect(body).toMatch(
        /cleanconnect_webhook_processing_failures_total\{event_type="payment_intent.succeeded",outcome="rejected"\} 1/,
      )
    })

    it('increments failures_total for outcome=failed', async () => {
      tracker.observe('transfer.created', 'failed', 2.5)
      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_webhook_processing_failures_total\{event_type="transfer.created",outcome="failed"\} 1/,
      )
    })

    it('does NOT touch failures_total for outcome=replayed', async () => {
      tracker.observe('payment_intent.succeeded', 'replayed', 0.01)
      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_webhook_processing_total\{event_type="payment_intent.succeeded",outcome="replayed"\} 1/,
      )
      expect(body).not.toMatch(
        /cleanconnect_webhook_processing_failures_total\{event_type="payment_intent.succeeded".*\} [1-9]/,
      )
    })

    it('handles undefined event_type → label "unknown"', async () => {
      tracker.recordOutcome(undefined, 'rejected')
      const body = (await metrics.render()).body
      expect(body).toMatch(
        /cleanconnect_webhook_processing_total\{event_type="unknown",outcome="rejected"\} 1/,
      )
    })
  })

  describe('normalizeEventType() — cardinality control', () => {
    it('returns whitelisted Stripe types as-is', () => {
      for (const t of KNOWN_STRIPE_EVENT_TYPES) {
        expect(normalizeEventType(t)).toBe(t)
      }
    })

    it('accepts well-formed Stripe types outside the whitelist', () => {
      expect(normalizeEventType('charge.dispute.created')).toBe('charge.dispute.created')
      expect(normalizeEventType('customer.subscription.deleted')).toBe(
        'customer.subscription.deleted',
      )
    })

    it('rejects malformed values to "unknown" (anti-cardinality)', () => {
      expect(normalizeEventType('')).toBe('unknown')
      expect(normalizeEventType(undefined)).toBe('unknown')
      expect(normalizeEventType('NotALowercaseType')).toBe('unknown')
      expect(normalizeEventType('with spaces.bad')).toBe('unknown')
      expect(normalizeEventType('a'.repeat(70))).toBe('unknown')
      expect(normalizeEventType('@bad')).toBe('unknown')
    })

    it('rejects payloads injected as event_type (e.g. JSON / SQL)', () => {
      expect(normalizeEventType('{"injected":1}')).toBe('unknown')
      expect(normalizeEventType("'; DROP TABLE")).toBe('unknown')
      expect(normalizeEventType('user@example.com')).toBe('unknown')
    })
  })
})
