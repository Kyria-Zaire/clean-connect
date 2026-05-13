/**
 * PRD-004 Ticket 4.5 — `FinanceMetricsTracker` typed facade.
 *
 * Source de vérité : PRD-004 §4.15.6 + ADR-018 §4.
 *
 * **Règle dure** : aucun module finance ne touche directement aux compteurs
 * Prometheus (`MetricsService.finance*`). Tout passe par ce tracker qui
 * applique les whitelists `FINANCE_METRIC_LABELS` (assertion runtime
 * + tests cardinalité).
 *
 * Cardinalité totale ajoutée (cf. PRD-004 §4.15.6) = 65 séries Prometheus —
 * largement bornée.
 *
 * Conditions Build CTO #2 (security pre-review) :
 *  - Whitelist labels enforced ✅
 *  - Aucun userId/missionId/paymentId/transferId/refundId/stripeId/email/phone
 *    en label ✅ (la signature TypeScript ne permet que les littéraux whitelistés)
 *  - Tests cardinalité unitaires (`finance-metrics.tracker.spec.ts`) ✅
 */

import { Injectable } from '@nestjs/common'

import { MetricsService } from '../../observability/metrics/metrics.service'
import {
  FINANCE_METRIC_LABELS,
  type FinanceSeverity,
} from '../finance.constants'

/** Type littéral des labels autorisés — propagé partout pour rejet à la compilation. */
export type FinanceRunMetricType = (typeof FINANCE_METRIC_LABELS.runTypes)[number]
export type FinanceRunMetricStatus = (typeof FINANCE_METRIC_LABELS.runStatuses)[number]
export type FinanceMismatchMetricType = (typeof FINANCE_METRIC_LABELS.mismatchTypes)[number]
export type FinanceStuckKind = (typeof FINANCE_METRIC_LABELS.stuckKinds)[number]
export type FinanceRefundMismatchKind = (typeof FINANCE_METRIC_LABELS.refundMismatchKinds)[number]
export type FinanceInvariantLabel = (typeof FINANCE_METRIC_LABELS.invariants)[number]
export type FinanceReportStatus = (typeof FINANCE_METRIC_LABELS.reportStatuses)[number]

/**
 * Garde runtime — vérifie qu'une valeur appartient à une whitelist littérale.
 * Lève une `Error` typée si la valeur est inconnue ; ne masque jamais
 * l'incident (rule senior-dev : pas de catch silencieux).
 */
function assertLabel<T extends string>(
  value: string,
  whitelist: readonly T[],
  context: string,
): asserts value is T {
  if (!whitelist.includes(value as T)) {
    throw new Error(
      `[finance-metrics] label hors whitelist (${context}) : "${value}" — autorisés : ${whitelist.join(',')}`,
    )
  }
}

@Injectable()
export class FinanceMetricsTracker {
  constructor(private readonly metrics: MetricsService) {}

  /** Cycle de vie run : appelé une fois par scheduler à la complétion. */
  recordRun(args: {
    type: FinanceRunMetricType
    status: FinanceRunMetricStatus
    durationMs: number
  }): void {
    assertLabel(args.type, FINANCE_METRIC_LABELS.runTypes, 'runs_total.type')
    assertLabel(args.status, FINANCE_METRIC_LABELS.runStatuses, 'runs_total.status')

    this.metrics.financeReconciliationRunsTotal.inc({
      type: args.type,
      status: args.status,
    })
    this.metrics.financeReconciliationDurationSeconds.observe(
      { type: args.type },
      args.durationMs / 1000,
    )
  }

  /** Mismatch détecté → counter + (au besoin) refresh gauge open via `setOpenMismatches`. */
  recordMismatch(args: {
    type: FinanceMismatchMetricType
    severity: FinanceSeverity
  }): void {
    assertLabel(args.type, FINANCE_METRIC_LABELS.mismatchTypes, 'mismatches_total.type')
    assertLabel(args.severity, FINANCE_METRIC_LABELS.severities, 'mismatches_total.severity')

    this.metrics.financeMismatchesTotal.inc({ type: args.type, severity: args.severity })
  }

  /**
   * Snapshot du nombre de mismatches OPEN par sévérité — réinitialise les
   * gauges (pas de drift cumulatif). Appelé en fin de chaque scheduler.
   */
  setOpenMismatches(snapshot: Partial<Record<FinanceSeverity, number>>): void {
    for (const severity of FINANCE_METRIC_LABELS.severities) {
      this.metrics.financeMismatchesOpenCount.set(
        { severity },
        Math.max(0, Math.trunc(snapshot[severity] ?? 0)),
      )
    }
  }

  /** Stuck funds — counter d'occurrences + gauge cumulé courant. */
  recordStuckFunds(args: { kind: FinanceStuckKind; totalAmountCents: number }): void {
    assertLabel(args.kind, FINANCE_METRIC_LABELS.stuckKinds, 'stuck_funds.kind')
    this.metrics.financeStuckFundsTotal.inc({ kind: args.kind })
    this.metrics.financeStuckFundsAmountCents.set(
      { kind: args.kind },
      Math.max(0, Math.trunc(args.totalAmountCents)),
    )
  }

  /** Reset gauges stuck funds à zéro pour kinds non observés au tick courant. */
  clearStuckFunds(kind: FinanceStuckKind): void {
    assertLabel(kind, FINANCE_METRIC_LABELS.stuckKinds, 'stuck_funds.kind')
    this.metrics.financeStuckFundsAmountCents.set({ kind }, 0)
  }

  /** I-10 — `Transfer.PENDING > 2h`. Pas de label métier (cardinalité 1). */
  recordTransferPending(): void {
    this.metrics.financeTransferPendingTotal.inc()
  }

  recordRefundMismatch(kind: FinanceRefundMismatchKind): void {
    assertLabel(kind, FINANCE_METRIC_LABELS.refundMismatchKinds, 'refund_mismatch.kind')
    this.metrics.financeRefundMismatchTotal.inc({ kind })
  }

  recordInvariantBreak(invariant: FinanceInvariantLabel): void {
    assertLabel(invariant, FINANCE_METRIC_LABELS.invariants, 'invariant_break.invariant')
    this.metrics.financeInvariantBreakTotal.inc({ invariant })
  }

  /** Gauge `J-1` invariant balance (cents). Reset à chaque daily report. */
  setInvariantBalanceCents(reportDateOffset: 'J-1', valueCents: number): void {
    this.metrics.financeInvariantBalanceCents.set(
      { report_date_offset: reportDateOffset },
      Math.trunc(valueCents),
    )
  }

  recordDailyReport(status: FinanceReportStatus): void {
    assertLabel(status, FINANCE_METRIC_LABELS.reportStatuses, 'daily_report.status')
    this.metrics.financeDailyReportGeneratedTotal.inc({ status })
  }

  /** Histogram payout anomaly factor. */
  observePayoutAnomalyFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor < 0) return
    this.metrics.financePayoutAnomalyFactor.observe(factor)
  }
}
