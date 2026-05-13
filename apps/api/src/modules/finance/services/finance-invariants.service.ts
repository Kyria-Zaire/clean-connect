import { Injectable, Logger } from '@nestjs/common'

import { FinanceRepository } from '../finance.repository'
import type { InvariantClock } from '../invariants/invariant.contract'
import { DAILY_INVARIANTS } from '../invariants/registry'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'

import { FinanceMismatchService } from './finance-mismatch.service'
import { computeJ1Window } from './finance-time.util'


/**
 * PRD-004 Ticket 4.5 Build itération 2 — Invariants journaliers (J-1).
 *
 * Pour MVP : applique uniquement `FIN-J-001` (balance comptable). Lance une
 * agrégation en J-1 Europe/Paris et persiste un mismatch INVARIANT_SUM si
 * `|balance| > tolérance`.
 *
 * Ce service est complémentaire au `FinanceDailyReportService` qui agrège les
 * mêmes données mais pour générer le report. Ils tournent à 04:15 et 07:00
 * respectivement (une heure pour résoudre l'éventuel mismatch avant le report).
 */
@Injectable()
export class FinanceInvariantsService {
  private readonly logger = new Logger(FinanceInvariantsService.name)
  private readonly clock: InvariantClock = { now: () => new Date() }

  constructor(
    private readonly repo: FinanceRepository,
    private readonly mismatches: FinanceMismatchService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  async run(): Promise<void> {
    const window = computeJ1Window(this.clock.now())
    const run = await this.repo.createRun({
      type: 'INVARIANTS',
      windowFrom: window.from,
      windowTo: window.to,
      triggeredByUserId: null,
    })
    this.logger.log(
      `finance.invariants.run.start runId=${run.id} from=${window.from.toISOString()} to=${window.to.toISOString()}`,
    )

    const startMs = Date.now()
    let mismatchesFound = 0
    let alertsEmitted = 0

    try {
      const agg = await this.repo.aggregateDailyReport({ from: window.from, to: window.to })
      const balanceCents =
        agg.capturedSumCents -
        agg.transferSentSumCents -
        agg.refundedSumCents -
        agg.applicationFeeSumCents
      this.metrics.setInvariantBalanceCents('J-1', balanceCents)

      for (const inv of DAILY_INVARIANTS) {
        const r = inv.apply(
          {
            reportDate: window.from,
            capturedSumCents: agg.capturedSumCents,
            transferSentSumCents: agg.transferSentSumCents,
            refundedSumCents: agg.refundedSumCents,
            applicationFeeSumCents: agg.applicationFeeSumCents,
          },
          this.clock,
        )
        if (!r) continue
        const persisted = await this.mismatches.persist({ runId: run.id, invariantBreak: r })
        if (persisted.persisted === 'created') mismatchesFound += 1
        if (persisted.alerted) alertsEmitted += 1
      }

      await this.repo.completeRun(run.id, {
        resourcesScanned: 1,
        mismatchesFound,
        alertsEmitted,
      })
      this.metrics.recordRun({
        type: 'INVARIANTS',
        status: 'COMPLETED',
        durationMs: Date.now() - startMs,
      })
      this.logger.log(
        `finance.invariants.run.done runId=${run.id} balanceCents=${balanceCents} mismatches=${mismatchesFound} alerts=${alertsEmitted}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      await this.repo.failRun(run.id, msg)
      this.metrics.recordRun({
        type: 'INVARIANTS',
        status: 'FAILED',
        durationMs: Date.now() - startMs,
      })
      this.logger.error(`finance.invariants.run.failed runId=${run.id} reason=${msg}`)
      throw e
    }
  }
}
