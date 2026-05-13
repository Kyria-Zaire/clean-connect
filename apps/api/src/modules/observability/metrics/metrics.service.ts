/**
 * MetricsService — registry Prometheus centralisé.
 *
 * Source de vérité :
 * - ADR-014 §2.5 (PRD-004 Ticket 4.1 Build A3) — fondations.
 * - Cahier CTO Build A3-bis — branchement runtime Stripe / webhook / DLQ.
 *
 * Politique de cardinalité :
 * - **Labels autorisés** : `method`, `route` (pattern normalisé), `status`,
 *   `queue`, `name` (job/event), `result`, `reason`, `operation`,
 *   `event_type`, `outcome`, `source`, `action`.
 * - **Labels interdits** (PII / cardinalité) : `missionId`, `userId`,
 *   `paymentId`, `paymentIntentId`, `stripeAccountId`, `customerId`,
 *   `email`, `requestId`, `traceId`, n'importe quel UUID — ces dimensions
 *   explosent la cardinalité (cf. règle Prometheus best practices <
 *   10 000 séries/metric).
 *
 * Le registry est `Registry()` dédié (pas `register` global). Cela permet :
 * - tests parallèles propres (reset entre suites)
 * - éviter la collision si une lib tierce utilise aussi prom-client
 *
 * Le service est singleton (`@Injectable()`) ; toutes les métriques sont
 * enregistrées à la construction → `getMetric()` ne fait que retourner la
 * référence (pas de re-création runtime).
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Préfixe Clean Connect — obligatoire pour distinguer les métriques business
 * des métriques runtime Node (`nodejs_*`, `process_*`) émises par
 * `collectDefaultMetrics`.
 */
const PREFIX = 'cleanconnect_'

/**
 * Buckets pour les histograms de latence HTTP / webhook (en secondes).
 * Choisis pour couvrir SLO API (~100-500 ms p95) et tail latency (5 s timeout).
 */
const LATENCY_BUCKETS_SECONDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const

/**
 * Buckets pour la latence Stripe API (en secondes). La latence p50 Stripe
 * tourne autour de 200-400 ms, p99 jusqu'à 2-5 s ; on étend jusqu'à 30 s
 * pour mesurer les timeouts longs (Connect, transfers) sans clipping.
 */
const STRIPE_LATENCY_BUCKETS_SECONDS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly registry: Registry

  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>
  readonly httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status'>
  readonly bullmqJobsTotal: Counter<'queue' | 'name' | 'result'>
  readonly bullmqJobsFailedTotal: Counter<'queue' | 'name' | 'reason'>

  // Webhook processing — A3-bis : labels `{event_type, outcome}` (CTO).
  readonly webhookProcessingTotal: Counter<'event_type' | 'outcome'>
  readonly webhookProcessingFailuresTotal: Counter<'event_type' | 'outcome'>
  readonly webhookProcessingDurationSeconds: Histogram<'event_type' | 'outcome'>

  // Stripe API — A3-bis : labels `{operation, status}` (CTO).
  readonly stripeApiCallsTotal: Counter<'operation' | 'status'>
  readonly stripeApiFailuresTotal: Counter<'operation' | 'status'>
  readonly stripeApiDurationSeconds: Histogram<'operation' | 'status'>

  // DLQ — gauge taille courante (A3) + counter d'événements (A3-bis).
  readonly dlqJobsTotal: Gauge<'queue'>
  readonly dlqEventsTotal: Counter<'source' | 'action'>

  // Finance — Ticket 4.5 (PRD-004 §4.15.6). Labels strictement whitelistés via
  // `FinanceMetricsTracker`. Toute injection brute ici est interdite (cf.
  // tests unit `finance-metrics.tracker.spec.ts`).
  readonly financeReconciliationRunsTotal: Counter<'type' | 'status'>
  readonly financeReconciliationDurationSeconds: Histogram<'type'>
  readonly financeMismatchesTotal: Counter<'type' | 'severity'>
  readonly financeMismatchesOpenCount: Gauge<'severity'>
  readonly financeStuckFundsTotal: Counter<'kind'>
  readonly financeStuckFundsAmountCents: Gauge<'kind'>
  readonly financeTransferPendingTotal: Counter
  readonly financeRefundMismatchTotal: Counter<'kind'>
  readonly financeInvariantBreakTotal: Counter<'invariant'>
  readonly financeInvariantBalanceCents: Gauge<'report_date_offset'>
  readonly financeDailyReportGeneratedTotal: Counter<'status'>
  readonly financePayoutAnomalyFactor: Histogram

  constructor() {
    this.registry = new Registry()

    collectDefaultMetrics({
      register: this.registry,
      prefix: 'cleanconnect_process_',
    })

    this.httpRequestsTotal = new Counter({
      name: `${PREFIX}http_requests_total`,
      help: 'Total HTTP requests handled by the API.',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [this.registry],
    })

    this.httpRequestDurationSeconds = new Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'HTTP request latency in seconds (route pattern, not raw URL).',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
    })

    this.bullmqJobsTotal = new Counter({
      name: `${PREFIX}bullmq_jobs_total`,
      help: 'Total BullMQ jobs processed (success or failure final state).',
      labelNames: ['queue', 'name', 'result'] as const,
      registers: [this.registry],
    })

    this.bullmqJobsFailedTotal = new Counter({
      name: `${PREFIX}bullmq_jobs_failed_total`,
      help: 'Total BullMQ jobs that ended in FAILED state after retries exhaustion.',
      labelNames: ['queue', 'name', 'reason'] as const,
      registers: [this.registry],
    })

    this.webhookProcessingTotal = new Counter({
      name: `${PREFIX}webhook_processing_total`,
      help: 'Total Stripe webhook events processed by ingestion + worker pipeline.',
      labelNames: ['event_type', 'outcome'] as const,
      registers: [this.registry],
    })

    this.webhookProcessingFailuresTotal = new Counter({
      name: `${PREFIX}webhook_processing_failures_total`,
      help: 'Webhook processing failures only (outcome=rejected|failed). Subset of webhook_processing_total for alert-friendly queries.',
      labelNames: ['event_type', 'outcome'] as const,
      registers: [this.registry],
    })

    this.webhookProcessingDurationSeconds = new Histogram({
      name: `${PREFIX}webhook_processing_duration_seconds`,
      help: 'Webhook event processing latency in seconds (ingestion + worker).',
      labelNames: ['event_type', 'outcome'] as const,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
    })

    this.stripeApiCallsTotal = new Counter({
      name: `${PREFIX}stripe_api_calls_total`,
      help: 'Total Stripe API calls performed by the backend (success+failure).',
      labelNames: ['operation', 'status'] as const,
      registers: [this.registry],
    })

    this.stripeApiFailuresTotal = new Counter({
      name: `${PREFIX}stripe_api_failures_total`,
      help: 'Stripe API failures only (subset of stripe_api_calls_total with status!=success).',
      labelNames: ['operation', 'status'] as const,
      registers: [this.registry],
    })

    this.stripeApiDurationSeconds = new Histogram({
      name: `${PREFIX}stripe_api_duration_seconds`,
      help: 'Stripe API call latency in seconds per operation.',
      labelNames: ['operation', 'status'] as const,
      buckets: [...STRIPE_LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
    })

    this.dlqJobsTotal = new Gauge({
      name: `${PREFIX}dlq_jobs_total`,
      help: 'Current number of jobs sitting in a dead-letter queue (gauge — refreshed on failed event).',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    })

    this.dlqEventsTotal = new Counter({
      name: `${PREFIX}dlq_events_total`,
      help: 'DLQ lifecycle events (enqueued, replayed, replay_failed) per source.',
      labelNames: ['source', 'action'] as const,
      registers: [this.registry],
    })

    // Finance — Ticket 4.5 (PRD-004 §4.15.6).
    this.financeReconciliationRunsTotal = new Counter({
      name: `${PREFIX}finance_reconciliation_runs_total`,
      help: 'Finance reconciliation runs executed per scheduler (terminal states).',
      labelNames: ['type', 'status'] as const,
      registers: [this.registry],
    })

    this.financeReconciliationDurationSeconds = new Histogram({
      name: `${PREFIX}finance_reconciliation_duration_seconds`,
      help: 'Finance reconciliation run duration in seconds, per scheduler type.',
      labelNames: ['type'] as const,
      // Buckets visent les SLO Design (RD-4.5-1 : reconcile < 5 min cible) +
      // tail latency 10 min pour cron full-window 7 j sur volume cible PRD-005.
      buckets: [1, 5, 15, 30, 60, 120, 300, 600] as const,
      registers: [this.registry],
    })

    this.financeMismatchesTotal = new Counter({
      name: `${PREFIX}finance_mismatches_total`,
      help: 'Total finance mismatches detected and persisted.',
      labelNames: ['type', 'severity'] as const,
      registers: [this.registry],
    })

    this.financeMismatchesOpenCount = new Gauge({
      name: `${PREFIX}finance_mismatches_open_count`,
      help: 'Current number of OPEN/INVESTIGATING finance mismatches (refreshed at each scheduler end).',
      labelNames: ['severity'] as const,
      registers: [this.registry],
    })

    this.financeStuckFundsTotal = new Counter({
      name: `${PREFIX}finance_stuck_funds_total`,
      help: 'Total stuck funds occurrences detected per kind.',
      labelNames: ['kind'] as const,
      registers: [this.registry],
    })

    this.financeStuckFundsAmountCents = new Gauge({
      name: `${PREFIX}finance_stuck_funds_amount_cents`,
      help: 'Current aggregated stuck funds amount (cents) per kind.',
      labelNames: ['kind'] as const,
      registers: [this.registry],
    })

    this.financeTransferPendingTotal = new Counter({
      name: `${PREFIX}finance_transfer_pending_total`,
      help: 'Total Transfer.PENDING > 2h occurrences detected by FinanceStuckFundsScheduler.',
      registers: [this.registry],
    })

    this.financeRefundMismatchTotal = new Counter({
      name: `${PREFIX}finance_refund_mismatch_total`,
      help: 'Total refund mismatches detected (Stripe ↔ DB) per kind.',
      labelNames: ['kind'] as const,
      registers: [this.registry],
    })

    this.financeInvariantBreakTotal = new Counter({
      name: `${PREFIX}finance_invariant_break_total`,
      help: 'Total finance invariant break events (I-1..I-11 + J-1).',
      labelNames: ['invariant'] as const,
      registers: [this.registry],
    })

    this.financeInvariantBalanceCents = new Gauge({
      name: `${PREFIX}finance_invariant_balance_cents`,
      help: 'Daily invariant balance (cents) — capture - transfer - refund - commission.',
      labelNames: ['report_date_offset'] as const,
      registers: [this.registry],
    })

    this.financeDailyReportGeneratedTotal = new Counter({
      name: `${PREFIX}finance_daily_report_generated_total`,
      help: 'Daily finance report generation outcome (success/failed/missing).',
      labelNames: ['status'] as const,
      registers: [this.registry],
    })

    this.financePayoutAnomalyFactor = new Histogram({
      name: `${PREFIX}finance_payout_anomaly_factor`,
      help: 'Distribution of payout anomaly factor (J-1 amount / avg last 30d).',
      buckets: [1.5, 2, 3, 5, 10] as const,
      registers: [this.registry],
    })
  }

  /**
   * Rendu Prometheus text format (`text/plain; version=0.0.4`). Appelé par
   * le controller `/api/internal/metrics`.
   */
  async render(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    }
  }

  /**
   * Test-only : reset le registry entre les tests parallèles.
   * @internal
   */
  __resetForTests(): void {
    this.registry.resetMetrics()
  }

  onModuleDestroy(): void {
    this.registry.clear()
  }
}
