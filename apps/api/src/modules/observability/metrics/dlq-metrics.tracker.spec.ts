/**
 * Tests DlqMetricsTracker — PRD-004 Ticket 4.1 Build A3-bis.
 *
 * Couvre les 3 transitions DLQ (enqueued / replayed / replay_failed)
 * et la séparation gauge/counter (gauge = taille, counter = events).
 */

import { DlqMetricsTracker } from './dlq-metrics.tracker'
import { MetricsService } from './metrics.service'

describe('DlqMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: DlqMetricsTracker

  beforeEach(() => {
    metrics = new MetricsService()
    tracker = new DlqMetricsTracker(metrics)
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
})
