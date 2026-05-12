/**
 * MetricsService — registry Prometheus centralisé (PRD-004 Ticket 4.1 — Build A3).
 *
 * Source de vérité : ADR-014 §2.5 + cahier CTO Build A3 (8 métriques minimales).
 *
 * Politique de cardinalité :
 * - **Labels autorisés** : `method`, `route` (pattern normalisé), `status`,
 *   `queue`, `name` (job/event), `provider`, `result`, `reason`.
 * - **Labels interdits** : `missionId`, `userId`, `paymentId`, `requestId`,
 *   `traceId`, n'importe quel UUID — ces dimensions explosent la cardinalité
 *   (cf. règle Prometheus best practices < 10 000 séries/metric).
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

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly registry: Registry

  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>
  readonly httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status'>
  readonly bullmqJobsTotal: Counter<'queue' | 'name' | 'result'>
  readonly bullmqJobsFailedTotal: Counter<'queue' | 'name' | 'reason'>
  readonly webhookProcessingTotal: Counter<'provider' | 'type' | 'result'>
  readonly webhookProcessingDurationSeconds: Histogram<'provider' | 'type' | 'result'>
  readonly stripeApiCallsTotal: Counter<'method' | 'status'>
  readonly dlqJobsTotal: Gauge<'queue'>

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
      help: 'Total webhook events processed (Stripe, Cloudinary, ...).',
      labelNames: ['provider', 'type', 'result'] as const,
      registers: [this.registry],
    })

    this.webhookProcessingDurationSeconds = new Histogram({
      name: `${PREFIX}webhook_processing_duration_seconds`,
      help: 'Webhook event processing latency in seconds.',
      labelNames: ['provider', 'type', 'result'] as const,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
    })

    this.stripeApiCallsTotal = new Counter({
      name: `${PREFIX}stripe_api_calls_total`,
      help: 'Total Stripe API calls performed by the backend.',
      labelNames: ['method', 'status'] as const,
      registers: [this.registry],
    })

    this.dlqJobsTotal = new Gauge({
      name: `${PREFIX}dlq_jobs_total`,
      help: 'Current number of jobs sitting in a dead-letter queue.',
      labelNames: ['queue'] as const,
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
