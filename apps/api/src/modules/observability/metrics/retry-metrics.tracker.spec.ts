import { MetricsService } from './metrics.service'
import {
  RetryMetricsTracker,
  RETRY_EXHAUSTED_JOB_TYPES,
  RETRY_EXHAUSTED_REASONS,
  type RetryExhaustedJobType,
  type RetryExhaustedReason,
} from './retry-metrics.tracker'

function readSeries(text: string, metric: string): Array<{ labels: string; value: number }> {
  const out: Array<{ labels: string; value: number }> = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue
    const match = /^[a-z_]+(\{[^}]*\}) (\d+(\.\d+)?)$/.exec(line)
    if (!match) continue
    out.push({ labels: match[1] as string, value: Number(match[2]) })
  }
  return out
}

describe('RetryMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: RetryMetricsTracker

  beforeEach(() => {
    metrics = new MetricsService()
    tracker = new RetryMetricsTracker(metrics)
  })

  afterEach(() => {
    metrics.onModuleDestroy()
  })

  it('exposes cleanconnect_bullmq_retry_exhausted_total with labels queue / job_type / reason', async () => {
    tracker.recordExhausted({
      queue: 'transfer-retry',
      jobType: 'transfer_payout',
      reason: 'transient_max_attempts',
    })
    const { body } = await metrics.render()

    expect(body).toContain('cleanconnect_bullmq_retry_exhausted_total')
    const series = readSeries(body, 'cleanconnect_bullmq_retry_exhausted_total')
    expect(series).toHaveLength(1)
    expect(series[0]!.labels).toContain('queue="transfer-retry"')
    expect(series[0]!.labels).toContain('job_type="transfer_payout"')
    expect(series[0]!.labels).toContain('reason="transient_max_attempts"')
    expect(series[0]!.value).toBe(1)
  })

  it('aggregates several increments on the same labels', async () => {
    for (let i = 0; i < 3; i += 1) {
      tracker.recordExhausted({
        queue: 'stripe-webhooks',
        jobType: 'stripe_webhook',
        reason: 'transient_max_attempts',
      })
    }
    const { body } = await metrics.render()
    const series = readSeries(body, 'cleanconnect_bullmq_retry_exhausted_total')
    expect(series).toHaveLength(1)
    expect(series[0]!.value).toBe(3)
  })

  it('keeps cardinality bounded by job_type × reason × queue', async () => {
    for (const jobType of RETRY_EXHAUSTED_JOB_TYPES) {
      for (const reason of RETRY_EXHAUSTED_REASONS) {
        tracker.recordExhausted({
          queue: 'escrow-auto-release',
          jobType: jobType as RetryExhaustedJobType,
          reason: reason as RetryExhaustedReason,
        })
      }
    }
    const { body } = await metrics.render()
    const series = readSeries(body, 'cleanconnect_bullmq_retry_exhausted_total')
    expect(series).toHaveLength(RETRY_EXHAUSTED_JOB_TYPES.length * RETRY_EXHAUSTED_REASONS.length)
  })

  it('does not leak any UUID or PII in labels', async () => {
    tracker.recordExhausted({
      queue: 'transfer-retry',
      jobType: 'transfer_payout',
      reason: 'permanent_error',
    })
    const { body } = await metrics.render()
    const metricLines = body.split('\n').filter((l) =>
      l.startsWith('cleanconnect_bullmq_retry_exhausted_total'),
    )
    for (const line of metricLines) {
      expect(line).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)
      expect(line).not.toMatch(/@[a-z0-9.-]+/i)
      expect(line).not.toMatch(/pi_[a-z0-9]/i)
      expect(line).not.toMatch(/tr_[a-z0-9]/i)
    }
  })
})
