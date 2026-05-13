import { Injectable, Logger } from '@nestjs/common'

import { FinanceRepository } from '../finance.repository'
import type { InvariantClock, StuckInvariantInput } from '../invariants/invariant.contract'
import { STUCK_INVARIANTS } from '../invariants/registry'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'

import { FinanceMismatchService } from './finance-mismatch.service'


/**
 * PRD-004 Ticket 4.5 Build itération 2 — Détecteur de fonds bloqués.
 *
 * Applique `STUCK_INVARIANTS` (FIN-I-009/010/011) sur :
 *  - Payments AUTHORIZED|CAPTURED (FIN-I-009 + FIN-I-011)
 *  - Transfers PENDING (FIN-I-010)
 *
 * Ne mute jamais Stripe ni la DB hors `finance_mismatches` / `finance_alerts`.
 * Cooldown alerting géré par `FinanceMismatchService.persist`.
 */
@Injectable()
export class FinanceStuckFundsService {
  private readonly logger = new Logger(FinanceStuckFundsService.name)
  private static readonly STUCK_BATCH_SIZE = 1000
  private readonly clock: InvariantClock = { now: () => new Date() }

  constructor(
    private readonly repo: FinanceRepository,
    private readonly mismatches: FinanceMismatchService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  async run(): Promise<void> {
    const windowFrom = new Date(0)
    const windowTo = this.clock.now()
    const run = await this.repo.createRun({
      type: 'STUCK',
      windowFrom,
      windowTo,
      triggeredByUserId: null,
    })
    this.logger.log(`finance.stuck.run.start runId=${run.id}`)
    const startMs = Date.now()
    let mismatchesFound = 0
    let alertsEmitted = 0
    let resourcesScanned = 0

    try {
      const [payments, transfers] = await Promise.all([
        this.repo.listPaymentsForStuckScan(FinanceStuckFundsService.STUCK_BATCH_SIZE),
        this.repo.listTransfersForStuckScan(FinanceStuckFundsService.STUCK_BATCH_SIZE),
      ])
      resourcesScanned = payments.length + transfers.length

      // Reset des gauges stuck — on recalcule la photo courante.
      this.metrics.clearStuckFunds('AUTHORIZATION')
      this.metrics.clearStuckFunds('CAPTURED')
      this.metrics.clearStuckFunds('PENDING')
      let stuckAuthSumCents = 0
      let stuckCapturedSumCents = 0
      let stuckPendingSumCents = 0

      for (const bundle of payments) {
        const input: StuckInvariantInput = {
          kind: 'PAYMENT',
          payment: bundle.payment,
          transfer: bundle.transfer,
          refunds: bundle.refunds,
          missionStatus: bundle.missionStatus,
        }
        for (const inv of STUCK_INVARIANTS) {
          const r = inv.apply(input, this.clock)
          if (!r) continue
          const persisted = await this.mismatches.persist({ runId: run.id, invariantBreak: r })
          if (persisted.persisted === 'created') mismatchesFound += 1
          if (persisted.alerted) alertsEmitted += 1
          if (r.mismatchType === 'STUCK_AUTHORIZATION') stuckAuthSumCents += bundle.payment.amountAuthorizedCents
          if (r.mismatchType === 'STUCK_CAPTURED') stuckCapturedSumCents += bundle.payment.amountCapturedCents ?? 0
        }
      }

      for (const bundle of transfers) {
        const input: StuckInvariantInput = {
          kind: 'TRANSFER',
          transfer: bundle.transfer,
          payment: bundle.payment,
          missionStatus: bundle.missionStatus,
        }
        for (const inv of STUCK_INVARIANTS) {
          const r = inv.apply(input, this.clock)
          if (!r) continue
          const persisted = await this.mismatches.persist({ runId: run.id, invariantBreak: r })
          if (persisted.persisted === 'created') mismatchesFound += 1
          if (persisted.alerted) alertsEmitted += 1
          if (r.mismatchType === 'STUCK_PENDING') stuckPendingSumCents += bundle.transfer.amountCents
        }
      }

      this.metrics.recordStuckFunds({ kind: 'AUTHORIZATION', totalAmountCents: stuckAuthSumCents })
      this.metrics.recordStuckFunds({ kind: 'CAPTURED', totalAmountCents: stuckCapturedSumCents })
      this.metrics.recordStuckFunds({ kind: 'PENDING', totalAmountCents: stuckPendingSumCents })

      await this.repo.completeRun(run.id, { resourcesScanned, mismatchesFound, alertsEmitted })
      this.metrics.recordRun({ type: 'STUCK', status: 'COMPLETED', durationMs: Date.now() - startMs })
      this.logger.log(
        `finance.stuck.run.done runId=${run.id} scanned=${resourcesScanned} mismatches=${mismatchesFound} alerts=${alertsEmitted}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      await this.repo.failRun(run.id, msg)
      this.metrics.recordRun({ type: 'STUCK', status: 'FAILED', durationMs: Date.now() - startMs })
      this.logger.error(`finance.stuck.run.failed runId=${run.id} reason=${msg}`)
      throw e
    }
  }
}
