import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { FINANCE_THRESHOLDS } from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'

import { computeJ1Window } from './finance-time.util'


/**
 * PRD-004 Ticket 4.5 Build itération 2 — Génération du daily report J-1.
 *
 * Pipeline :
 *   1. Calcule la fenêtre J-1 (Europe/Paris).
 *   2. Agrège captured / transferSent / refunded / commission depuis la DB.
 *   3. Calcule `invariantBalanceCents` (FIN-J-001) — si dépasse la tolérance,
 *      report status = `failed` (l'invariant a déjà alerté côté
 *      `FinanceInvariantsService`, on évite le doublon).
 *   4. Persiste `FinanceDailyReport` (upsert sur `reportDate`).
 *   5. Prépare le payload email (TODO debt — branchement Resend Ticket 4.1 PR #20).
 *
 * Aucun email envoyé pour l'instant. Le payload est exposé via
 * `GET /v1/admin/finance/daily-report/:date` pour vérification ops.
 *
 * Aucun PII : on ne référence aucun userId / missionId / paymentId. Les
 * compteurs et sommes en cents sont les seules valeurs persistées.
 */
@Injectable()
export class FinanceDailyReportService {
  private readonly logger = new Logger(FinanceDailyReportService.name)

  constructor(
    private readonly repo: FinanceRepository,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  async run(): Promise<void> {
    const now = new Date()
    const window = computeJ1Window(now)
    const startMs = Date.now()
    const run = await this.repo.createRun({
      type: 'REPORT',
      windowFrom: window.from,
      windowTo: window.to,
      triggeredByUserId: null,
    })
    this.logger.log(
      `finance.daily_report.run.start runId=${run.id} from=${window.from.toISOString()} to=${window.to.toISOString()}`,
    )

    try {
      const agg = await this.repo.aggregateDailyReport({ from: window.from, to: window.to })
      const balanceCents =
        agg.capturedSumCents -
        agg.transferSentSumCents -
        agg.refundedSumCents -
        agg.applicationFeeSumCents
      const open = await this.repo.countOpenMismatchesBySeverity()
      const isHealthy =
        Math.abs(balanceCents) <= FINANCE_THRESHOLDS.invariantBalanceToleranceCents

      const snapshot: Prisma.InputJsonValue = {
        kind: 'finance.daily_report.v1',
        reportDateIso: window.from.toISOString(),
        balanceCents,
        captured: { sumCents: agg.capturedSumCents, count: agg.capturedCount },
        transferSent: { sumCents: agg.transferSentSumCents, count: agg.transferSentCount },
        refunded: { sumCents: agg.refundedSumCents, count: agg.refundedCount },
        commission: { sumCents: agg.applicationFeeSumCents },
        openMismatches: open,
        balanceHealthy: isHealthy,
      }

      await this.repo.upsertDailyReport({
        reportDate: window.from,
        windowFrom: window.from,
        windowTo: window.to,
        snapshot,
        capturedCents: agg.capturedSumCents,
        transferSentCents: agg.transferSentSumCents,
        refundedCents: agg.refundedSumCents,
        commissionCents: agg.applicationFeeSumCents,
        invariantBalanceCents: balanceCents,
        capturedCount: agg.capturedCount,
        transferSentCount: agg.transferSentCount,
        refundedCount: agg.refundedCount,
        openMismatchCount: open.P1 + open.P2,
      })

      this.metrics.recordDailyReport(isHealthy ? 'success' : 'failed')
      await this.repo.completeRun(run.id, {
        resourcesScanned: 1,
        mismatchesFound: 0,
        alertsEmitted: 0,
      })
      this.metrics.recordRun({
        type: 'REPORT',
        status: 'COMPLETED',
        durationMs: Date.now() - startMs,
      })
      this.logger.log(
        `finance.daily_report.run.done runId=${run.id} balanceCents=${balanceCents} healthy=${isHealthy} openP1=${open.P1} openP2=${open.P2}`,
      )

      // TODO(debt) finance-daily-report-email — brancher AlertingService.emit(email)
      // (Resend) quand PR #20 mergée. Pour MVP, le report est consultable via
      // `GET /v1/admin/finance/daily-report/:date`.
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      this.metrics.recordDailyReport('failed')
      await this.repo.failRun(run.id, msg)
      this.metrics.recordRun({
        type: 'REPORT',
        status: 'FAILED',
        durationMs: Date.now() - startMs,
      })
      this.logger.error(`finance.daily_report.run.failed runId=${run.id} reason=${msg}`)
      throw e
    }
  }

  /**
   * Build itération 2 — Helper pour générer le payload email Resend
   * (sans envoi). Réutilisable côté `AdminFinanceController.getDailyReport`
   * pour le preview admin.
   */
  buildEmailPayload(snapshot: Record<string, unknown>): { subject: string; bodyText: string } {
    const dateLabel = String(snapshot['reportDateIso'] ?? '').slice(0, 10)
    const lines = [
      `Daily finance report — ${dateLabel}`,
      `Balance J-1 : ${snapshot['balanceCents']} cents (sain=${snapshot['balanceHealthy']})`,
      `Captured : ${(snapshot['captured'] as Record<string, unknown> | undefined)?.['sumCents']} cents`,
      `Transfers SENT : ${(snapshot['transferSent'] as Record<string, unknown> | undefined)?.['sumCents']} cents`,
      `Refunds : ${(snapshot['refunded'] as Record<string, unknown> | undefined)?.['sumCents']} cents`,
      `Commission : ${(snapshot['commission'] as Record<string, unknown> | undefined)?.['sumCents']} cents`,
      `Open mismatches : P1=${(snapshot['openMismatches'] as Record<string, unknown> | undefined)?.['P1']} ` +
        `P2=${(snapshot['openMismatches'] as Record<string, unknown> | undefined)?.['P2']}`,
    ]
    return {
      subject: `[Clean Connect] Daily finance report ${dateLabel}`,
      bodyText: lines.join('\n'),
    }
  }
}
