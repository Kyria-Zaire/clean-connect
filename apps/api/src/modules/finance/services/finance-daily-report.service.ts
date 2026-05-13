import { Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { loadEnv } from '../../../common/config/env'
import { FinanceAlertingService } from '../alerting/finance-alerting.service'
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
 *   5. `FIN-DAILY-EMAIL` (PRD §4.15.17) — envoi Resend HTTP si
 *      `RESEND_API_KEY` + `FINANCE_DAILY_REPORT_EMAIL_TO` + adresse `from`
 *      (`RESEND_FROM_EMAIL` ou `MAIL_FROM`) sont présents. Aucun PII dans le
 *      corps (uniquement agrégats + compteurs). Échec Resend ⇒ alerte P1
 *      `finance_daily_report_failed` (cooldown 1h / scope `email:<date>`).
 *
 * Échec génération (exception avant `completeRun`) ⇒ même kind d'alerte avec
 * `stage=generation` (P1, cooldown séparé).
 *
 * Le payload reste exposé via `GET /v1/admin/finance/daily-report/:date`.
 */
@Injectable()
export class FinanceDailyReportService {
  private readonly logger = new Logger(FinanceDailyReportService.name)

  constructor(
    private readonly repo: FinanceRepository,
    private readonly metrics: FinanceMetricsTracker,
    private readonly alerting: FinanceAlertingService,
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

      let alertsEmitted = 0
      const emailOutcome = await this.trySendDailyReportEmail({
        runId: run.id,
        snapshot: snapshot as unknown as Record<string, unknown>,
      })
      if (emailOutcome === 'alerted') alertsEmitted += 1

      await this.repo.completeRun(run.id, {
        resourcesScanned: 1,
        mismatchesFound: 0,
        alertsEmitted,
      })
      this.metrics.recordRun({
        type: 'REPORT',
        status: 'COMPLETED',
        durationMs: Date.now() - startMs,
      })
      this.logger.log(
        `finance.daily_report.run.done runId=${run.id} balanceCents=${balanceCents} healthy=${isHealthy} openP1=${open.P1} openP2=${open.P2}`,
      )
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

      await this.emitDailyReportFailedAlert({
        runId: run.id,
        stage: 'generation',
        detail: msg.slice(0, 200),
        snapshot: {
          kind: 'finance.daily_report.v1',
          reportDateIso: window.from.toISOString(),
        },
      }).catch((ae) => {
        this.logger.error(`finance.daily_report.alert_emit_failed err=${stringErr(ae)}`)
      })

      throw e
    }
  }

  /**
   * Build itération 2 — Helper pour générer le payload email Resend
   * (sans PII). Réutilisable côté `AdminFinanceController.getDailyReport`
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

  private async trySendDailyReportEmail(args: {
    runId: string
    snapshot: Record<string, unknown>
  }): Promise<'skipped' | 'sent' | 'alerted'> {
    const env = loadEnv()
    if (!env.RESEND_API_KEY || !env.FINANCE_DAILY_REPORT_EMAIL_TO) {
      this.logger.debug('finance.daily_report.email_skipped_no_resend_config')
      return 'skipped'
    }

    const from = env.RESEND_FROM_EMAIL ?? env.MAIL_FROM
    if (!from) {
      this.logger.warn('finance.daily_report.email_skipped_no_from_address')
      return 'skipped'
    }

    const { subject, bodyText } = this.buildEmailPayload(args.snapshot)

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [env.FINANCE_DAILY_REPORT_EMAIL_TO],
          subject,
          text: bodyText,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        await this.emitDailyReportFailedAlert({
          runId: args.runId,
          stage: 'email',
          detail: `http_${res.status}:${body.slice(0, 180)}`,
          snapshot: args.snapshot,
        })
        return 'alerted'
      }

      this.logger.log(`finance.daily_report.email_sent runId=${args.runId}`)
      return 'sent'
    } catch (err) {
      await this.emitDailyReportFailedAlert({
        runId: args.runId,
        stage: 'email',
        detail: stringErr(err).slice(0, 200),
        snapshot: args.snapshot,
      })
      return 'alerted'
    }
  }

  private async emitDailyReportFailedAlert(args: {
    runId: string
    stage: 'generation' | 'email'
    detail: string
    snapshot: Record<string, unknown>
  }): Promise<void> {
    const dateLabel = String(args.snapshot['reportDateIso'] ?? '').slice(0, 10)
    await this.alerting.emit({
      kind: 'finance_daily_report_failed',
      severity: 'P1',
      runId: args.runId,
      cooldownScope: `${args.stage}:${dateLabel}`,
      context: {
        stage: args.stage,
        detail: args.detail,
      },
    })
  }
}

function stringErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
