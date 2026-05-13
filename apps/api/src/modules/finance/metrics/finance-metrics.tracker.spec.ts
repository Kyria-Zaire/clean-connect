import { MetricsService } from '../../observability/metrics/metrics.service'

import { FinanceMetricsTracker } from './finance-metrics.tracker'

describe('FinanceMetricsTracker', () => {
  let metrics: MetricsService
  let tracker: FinanceMetricsTracker

  beforeEach(() => {
    metrics = new MetricsService()
    tracker = new FinanceMetricsTracker(metrics)
  })

  afterEach(() => {
    metrics.onModuleDestroy()
  })

  it('rejects unknown run.type labels (whitelist enforcement)', () => {
    expect(() =>
      tracker.recordRun({ type: 'UNKNOWN' as never, status: 'COMPLETED', durationMs: 1 }),
    ).toThrow(/label hors whitelist/)
  })

  it('records a bounded finance metric series', async () => {
    tracker.recordRun({ type: 'RECONCILE', status: 'COMPLETED', durationMs: 250 })
    tracker.recordMismatch({ type: 'STATUS', severity: 'P1' })

    const body = (await metrics.render()).body
    expect(body).toMatch(
      /cleanconnect_finance_reconciliation_runs_total\{type="RECONCILE",status="COMPLETED"\} 1/,
    )
    expect(body).toMatch(/cleanconnect_finance_mismatches_total\{type="STATUS",severity="P1"\} 1/)
  })
})
