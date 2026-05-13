/**
 * PRD-004 Ticket 4.5 — Constants Finance.
 *
 * Source de vérité : PRD-004 §4.15.4 / §4.15.6 / §4.15.7 + ADR-018.
 *
 * **Pas de logique métier ici** — uniquement :
 *  - whitelists de labels Prometheus (rule architecte-api : cardinalité bornée)
 *  - cron expressions (rule senior-dev : valeurs figées vérifiables)
 *  - clés de lock anti-overlap (ajustement CTO Build §4.15)
 *  - whitelist snapshot DB/Stripe (rule securite : exfiltration PII contrôlée)
 *
 * Toute valeur "magique" dans un service doit pointer ici.
 */

import type { FinanceRunType } from '@prisma/client'

/**
 * Clés de lock anti-overlap — une par scheduler. Permet un INSERT idempotent
 * (`INSERT … ON CONFLICT DO UPDATE WHERE expires_at < NOW()`) — un seul run
 * actif par scheduler à un instant T (CTO Build ajustement).
 */
export const FINANCE_LOCK_KEYS = {
  reconcile: 'finance.reconcile',
  stuck: 'finance.stuck',
  invariants: 'finance.invariants',
  payoutAnomaly: 'finance.payout_anomaly',
  report: 'finance.report',
  retention: 'finance.retention',
} as const

export type FinanceLockKey = (typeof FINANCE_LOCK_KEYS)[keyof typeof FINANCE_LOCK_KEYS]

/**
 * Cron expressions (timezone Europe/Paris pilotée côté `@Cron({ timeZone })`).
 * PRD-004 §4.15.3 + ADR-018 §2.3. Décalages volontaires pour éviter le
 * chevauchement de pics d'I/O DB.
 */
export const FINANCE_CRON = {
  /** AC-4.5.1.1 — reconcile quotidien 03:30 Europe/Paris. */
  reconcile: '30 3 * * *',
  /** AC-4.5.2.1 — stuck funds horaire à HH:05 Europe/Paris. */
  stuckFunds: '5 * * * *',
  /** AC-4.5.5.1 — invariants quotidiens 04:15 Europe/Paris. */
  invariants: '15 4 * * *',
  /** AC-4.5.3.1 — payout anomaly quotidien 04:45 Europe/Paris. */
  payoutAnomaly: '45 4 * * *',
  /** AC-4.5.4.1 — daily report 07:00 Europe/Paris. */
  dailyReport: '0 7 * * *',
  /** Retention/purge quotidien 02:30 Europe/Paris (creux trafic). */
  retention: '30 2 * * *',
} as const

export const FINANCE_TIMEZONE = 'Europe/Paris' as const

/**
 * TTL des locks par cron — toujours > durée max attendue + marge. Si un worker
 * crash sans `release`, le lock expire seul (auto-cleanable).
 */
export const FINANCE_LOCK_TTL_MS = {
  reconcile: 15 * 60_000,
  stuck: 10 * 60_000,
  invariants: 15 * 60_000,
  payoutAnomaly: 10 * 60_000,
  report: 10 * 60_000,
  retention: 10 * 60_000,
} as const satisfies Record<keyof typeof FINANCE_LOCK_KEYS, number>

/**
 * Fenêtre temporelle (jours) pour le scheduler `RECONCILE`. PRD-004 §4.15.3
 * AC-4.5.1.1 — par défaut on regarde les rows modifiées dans les 7 j passés.
 */
export const FINANCE_RECONCILE_WINDOW_DAYS = 7

/**
 * Seuils figés Design (ne dépendent pas de l'env — modifiables uniquement
 * via ADR dédiée).
 */
export const FINANCE_THRESHOLDS = {
  /** AC-4.5.2.2 — `Payment.AUTHORIZED` > 5 j ⇒ alerte préventive. */
  authorizationAgeDays: 5,
  /** AC-4.5.2.3 / OQ-15 — `Payment.CAPTURED` sans Transfer > 24 h ⇒ P1. */
  capturedWithoutTransferHours: 24,
  /** AC-4.5.2.4 / I-10 — `Transfer.PENDING` > 2 h ⇒ P2. */
  transferPendingHours: 2,
  /** AC-4.5.3.1 — fenêtre moyenne payout pour anomaly detector. */
  payoutAvgWindowDays: 30,
  /** Tolérance arrondi euros (1 cent) sur `invariantBalanceCents` J-1. */
  invariantBalanceToleranceCents: 1,
} as const

/**
 * Whitelist labels Prometheus — PRD-004 §4.15.6.
 *
 * **Règle dure** : tout `inc()/observe()` côté `FinanceMetricsTracker` DOIT
 * passer par ces littéraux. Toute valeur hors whitelist est rejetée
 * (assertion runtime + tests cardinalité).
 */
export const FINANCE_METRIC_LABELS = Object.freeze({
  /** `cleanconnect_finance_reconciliation_runs_total.type`. */
  runTypes: ['RECONCILE', 'STUCK', 'INVARIANTS', 'REPORT', 'PAYOUT_ANOMALY'] as const,
  /** `cleanconnect_finance_reconciliation_runs_total.status`. */
  runStatuses: ['COMPLETED', 'FAILED'] as const,
  /** `cleanconnect_finance_mismatches_total.type`. */
  mismatchTypes: [
    'STATUS',
    'AMOUNT',
    'CURRENCY',
    'MISSING_DB',
    'MISSING_STRIPE',
    'INVARIANT_SUM',
    'STUCK_PENDING',
    'STUCK_AUTHORIZATION',
    'STUCK_CAPTURED',
    'PAYOUT_ANOMALY',
  ] as const,
  /** `cleanconnect_finance_mismatches_total.severity` + assimilées. */
  severities: ['P1', 'P2'] as const,
  /** `cleanconnect_finance_stuck_funds_total.kind`. */
  stuckKinds: ['AUTHORIZATION', 'CAPTURED', 'PENDING'] as const,
  /** `cleanconnect_finance_refund_mismatch_total.kind`. */
  refundMismatchKinds: ['AMOUNT', 'STATUS', 'MISSING_STRIPE', 'MISSING_DB'] as const,
  /** `cleanconnect_finance_invariant_break_total.invariant` — codes versionnés (Build itération 2). */
  invariants: [
    'FIN-I-001',
    'FIN-I-002',
    'FIN-I-003',
    'FIN-I-004',
    'FIN-I-005',
    'FIN-I-006',
    'FIN-I-007',
    'FIN-I-008',
    'FIN-I-009',
    'FIN-I-010',
    'FIN-I-011',
    'FIN-J-001',
  ] as const,
  /** `cleanconnect_finance_daily_report_generated_total.status`. */
  reportStatuses: ['success', 'failed', 'missing'] as const,
})

/**
 * Sévérité — type littéral utilisé partout côté finance (P1/P2 uniquement).
 * P0 n'est PAS prévu pour finance — toute escalade vers P0 doit faire l'objet
 * d'un ADR (cf. ADR-018 §2.5).
 */
export type FinanceSeverity = (typeof FINANCE_METRIC_LABELS.severities)[number]

/**
 * Whitelist `dbSnapshot` (`FinanceMismatch.dbSnapshot`) — ADR-018 §4.1.
 *
 * **Aucun champ contenant PII ne doit apparaître ici**. La whitelist est
 * appliquée AVANT `deepSanitize` (qui re-redact tout pattern PII connu).
 * Double filet de sécurité (audit + fuzz tests).
 *
 * Le mapping est par `resourceKind` → champs autorisés.
 */
export const FINANCE_SNAPSHOT_WHITELIST = Object.freeze({
  PAYMENT: [
    'id',
    'status',
    'amountAuthorizedCents',
    'amountCapturedCents',
    'currency',
    'applicationFeeCents',
    'providerPayoutCents',
    'failureCode',
    'createdAt',
    'updatedAt',
    'stripePaymentIntentIdTruncated',
  ] as const,
  TRANSFER: [
    'id',
    'status',
    'amountCents',
    'currency',
    'retryCount',
    'failureCode',
    'createdAt',
    'updatedAt',
    'stripeTransferIdTruncated',
  ] as const,
  REFUND: [
    'id',
    'status',
    'amountCents',
    'currency',
    'failureCode',
    'initiatedBy',
    'createdAt',
    'settledAt',
    'stripeRefundIdTruncated',
  ] as const,
  INVARIANT: [
    'invariant',
    'leftCents',
    'rightCents',
    'deltaCents',
    'reportDate',
  ] as const,
})

/** Longueur max d'un `stripeId` exposé en snapshot/alert (PRD-004 §4.15.7). */
export const FINANCE_STRIPE_ID_TRUNCATE_LENGTH = 24

/**
 * Type d'évènement audit MissionEvent posé sur les mutations admin finance —
 * audit-trail dédié pour `markResolved`, `markIgnored`, `manualRun`, etc.
 *
 * MissionEvent.payload est restreint via `sanitizeForFinanceSnapshot` ⇒ aucun
 * PII ne fuite vers l'audit.
 */
export const FINANCE_AUDIT_EVENT_TYPES = {
  mismatchAcknowledged: 'FINANCE_MISMATCH_ACKNOWLEDGED',
  mismatchInvestigating: 'FINANCE_MISMATCH_INVESTIGATING',
  mismatchResolved: 'FINANCE_MISMATCH_RESOLVED',
  mismatchIgnored: 'FINANCE_MISMATCH_IGNORED',
  manualRunTriggered: 'FINANCE_MANUAL_RUN_TRIGGERED',
} as const

/**
 * Build itération 2 — Machine d'état stricte `FinanceMismatchStatus`.
 * Toute transition non listée ⇒ refus avec `FINANCE_MISMATCH_TRANSITION_INVALID`.
 *
 * Décision Build CTO : pas de retour `OPEN` (nouveau mismatch ⇒ nouveau row).
 * Pas de transition implicite côté code — `FinanceMismatchService.transition`
 * vérifie via `assertTransitionAllowed`.
 */
export const FINANCE_MISMATCH_TRANSITIONS = Object.freeze({
  OPEN: ['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'IGNORED'] as const,
  ACKNOWLEDGED: ['INVESTIGATING', 'RESOLVED', 'IGNORED'] as const,
  INVESTIGATING: ['ACKNOWLEDGED', 'RESOLVED', 'IGNORED'] as const,
  RESOLVED: [] as const,
  IGNORED: [] as const,
})

/**
 * Build itération 2 — Codes invariants déterministes versionnés (PRD §4.15.5).
 * Source de vérité pour : tests, dashboards, alertes, exports, runbook.
 *
 * Convention : `FIN-I-NNN` (invariants ponctuels DB ↔ Stripe ↔ inter-table) +
 * `FIN-J-NNN` (invariants journaliers J-1, balance comptable).
 */
export const FINANCE_INVARIANT_CODES = Object.freeze({
  /** I-1 historique — `Payment.CAPTURED ⇒ amountCapturedCents > 0`. */
  CAPTURED_REQUIRES_AMOUNT: 'FIN-I-001',
  /** I-2 historique — `Transfer.SENT ⇒ Payment.CAPTURED`. */
  TRANSFER_SENT_IMPLIES_CAPTURED: 'FIN-I-002',
  /** I-3 historique — `Transfer.amountCents = Payment.providerPayoutCents`. */
  TRANSFER_AMOUNT_EQUALS_PROVIDER_PAYOUT: 'FIN-I-003',
  /** I-4 historique — `Refund.REFUNDED ⇒ Payment.{CAPTURED,REFUNDED}`. */
  REFUND_IMPLIES_CAPTURED_OR_REFUNDED: 'FIN-I-004',
  /** I-5 historique — `Refund post-Transfer.SENT ⇒ initiatedBy != SYSTEM`. */
  REFUND_AFTER_TRANSFER_NOT_AUTOMATIC: 'FIN-I-005',
  /** I-6 historique — `Stripe.PI.amount_received = DB.Payment.amountCapturedCents`. */
  STRIPE_PI_AMOUNT_MATCHES_DB: 'FIN-I-006',
  /** I-7 historique — `Stripe.Transfer.amount = DB.Transfer.amountCents`. */
  STRIPE_TRANSFER_AMOUNT_MATCHES_DB: 'FIN-I-007',
  /** I-8 historique — `Stripe.Refund.amount = DB.Refund.amountCents`. */
  STRIPE_REFUND_AMOUNT_MATCHES_DB: 'FIN-I-008',
  /** I-9 historique — `Payment.AUTHORIZED ∧ age > 5 j`. */
  STUCK_AUTHORIZATION: 'FIN-I-009',
  /** I-10 historique — `Transfer.PENDING > 2 h ∧ Mission ≠ DISPUTE_OPEN`. */
  STUCK_TRANSFER_PENDING: 'FIN-I-010',
  /** I-11 historique — `Payment.CAPTURED ∧ pas de Transfer terminal > 24 h`. */
  STUCK_CAPTURED_WITHOUT_TRANSFER: 'FIN-I-011',
  /** J-1 historique — invariant comptable journalier (balance euros). */
  DAILY_BALANCE: 'FIN-J-001',
} as const)

export type FinanceInvariantCode =
  (typeof FINANCE_INVARIANT_CODES)[keyof typeof FINANCE_INVARIANT_CODES]

/**
 * Routage `FinanceRunType` ↔ clé lock — utilisé par le scheduler dispatcher
 * (un seul tableau de vérité, pas de switch dupliqué).
 */
export const FINANCE_RUN_TYPE_TO_LOCK_KEY: Record<FinanceRunType, FinanceLockKey> = {
  RECONCILE: FINANCE_LOCK_KEYS.reconcile,
  STUCK: FINANCE_LOCK_KEYS.stuck,
  INVARIANTS: FINANCE_LOCK_KEYS.invariants,
  PAYOUT_ANOMALY: FINANCE_LOCK_KEYS.payoutAnomaly,
  REPORT: FINANCE_LOCK_KEYS.report,
}

/**
 * `FIN-STALE-RUNS` (PRD-004 §4.15.17) — Âge max d'un `FinanceReconciliationRun`
 * en `RUNNING` avant qu'il soit considéré comme zombie (worker crashé entre
 * `createRun` et `completeRun/failRun`). Alignée sur `FINANCE_LOCK_TTL_MS` pour
 * cohérence : le lock expire au même moment que le run devient "stale".
 *
 * Source de vérité unique pour `repo.markAllStaleRunningRunsFailed(...)`.
 */
export const FINANCE_RUN_TYPE_MAX_AGE_MS: Readonly<Record<FinanceRunType, number>> = Object.freeze({
  RECONCILE: FINANCE_LOCK_TTL_MS.reconcile,
  STUCK: FINANCE_LOCK_TTL_MS.stuck,
  INVARIANTS: FINANCE_LOCK_TTL_MS.invariants,
  PAYOUT_ANOMALY: FINANCE_LOCK_TTL_MS.payoutAnomaly,
  REPORT: FINANCE_LOCK_TTL_MS.report,
})
