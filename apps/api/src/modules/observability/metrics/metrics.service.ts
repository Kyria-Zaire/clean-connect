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
