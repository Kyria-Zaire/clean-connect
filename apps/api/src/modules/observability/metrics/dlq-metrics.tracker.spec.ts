/**
 * Tests DlqMetricsTracker — PRD-004 Ticket 4.1 Build A3-bis + Ticket 4.2.
 *
 * Couvre :
 *  - les 3 transitions DLQ (enqueued / replayed / replay_failed)
 *  - la séparation gauge/counter (gauge = taille, counter = events)
 *  - PRD-004 Ticket 4.2 : alerte P1 `dlq_growth` sur chaque enqueue,
 *    pas d'alerte sur replayed/replay_failed (pas de signal opérationnel
 *    d'urgence).
 */

import type { AlertingService } from '../alerting/alerting.service'
import type { AlertPayload } from '../alerting/alerting.types'

import { DlqMetricsTracker } from './dlq-metrics.tracker'
import { MetricsService } from './metrics.service'

function makeAlertingMock(): {
  alerting: AlertingService
  emitted: AlertPayload[]
} {
  const emitted: AlertPayload[] = []
  const alerting = {
    emit: jest.fn(async (p: AlertPayload) => {
      emitted.push(p)
    }),
  } as unknown as AlertingService
  return { alerting, emitted }
}

describe('DlqMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: DlqMetricsTracker
  let alertingState: { alerting: AlertingService; emitted: AlertPayload[] }

  beforeEach(() => {
    metrics = new MetricsService()
    alertingState = makeAlertingMock()
    tracker = new DlqMetricsTracker(metrics, alertingState.alerting)
  })

  afterEach(() => {
    metrics.onModuleDestroy()
  })

  it('increments dlq_events_total with action=enqueued', async () => {
    tracker.recordEnqueued('stripe')
    tracker.recordEnqueued('stripe')
    const body = (await metrics.render()).body
    expect(body).toMatch(/cleanconnect_dlq_events_total\{source="stripe",action="enqueued"\} 2/)
  })

  it('increments dlq_events_total with action=replayed', async () => {
    tracker.recordReplayed('stripe')
    const body = (await metrics.render()).body
    expect(body).toMatch(/cleanconnect_dlq_events_total\{source="stripe",action="replayed"\} 1/)
  })

  it('increments dlq_events_total with action=replay_failed', async () => {
    tracker.recordReplayFailed('stripe')
    const body = (await metrics.render()).body
    expect(body).toMatch(/cleanconnect_dlq_events_total\{source="stripe",action="replay_failed"\} 1/)
  })

  it('does not pollute the gauge dlq_jobs_total (different semantics)', async () => {
    tracker.recordEnqueued('stripe')
    const body = (await metrics.render()).body
    // dlq_jobs_total reste à 0 (la gauge est gérée par BullMqMetricsService —
    // separation of concerns event/counter vs taille/gauge).
    expect(body).not.toMatch(/cleanconnect_dlq_jobs_total\{queue=.*\} [1-9]/)
  })

  // -------------------------------------------------------------------------
  // PRD-004 Ticket 4.2 — alerting P1 dlq_growth
  // -------------------------------------------------------------------------

  it('emits P1 dlq_growth alert on every recordEnqueued (cooldown handled upstream)', () => {
    tracker.recordEnqueued('stripe')
    expect(alertingState.emitted).toHaveLength(1)
    expect(alertingState.emitted[0]!.severity).toBe('P1')
    expect(alertingState.emitted[0]!.kind).toBe('dlq_growth')
    expect(alertingState.emitted[0]!.context).toEqual({ source: 'stripe' })
  })

  it('does NOT emit alert on recordReplayed', () => {
    tracker.recordReplayed('stripe')
    expect(alertingState.emitted).toHaveLength(0)
  })

  it('does NOT emit alert on recordReplayFailed', () => {
    tracker.recordReplayFailed('stripe')
    expect(alertingState.emitted).toHaveLength(0)
  })

  it('does not include event ID or PII in alert context', () => {
    tracker.recordEnqueued('stripe')
    const alert = alertingState.emitted[0]!
    const json = JSON.stringify(alert)
    expect(json).not.toMatch(/evt_[a-z0-9]/i)
    expect(json).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-/i)
  })
})
