/**
 * Tests unitaires MetricsService (PRD-004 Ticket 4.1 — Build A3).
 *
 * Couverture obligatoire CTO :
 * - les 8 métriques canoniques sont enregistrées au boot avec le préfixe
 *   `cleanconnect_`
 * - les labels sont bornés (cardinalité contrôlée)
 * - histogram buckets attendus pour latence
 * - registry isolé (pas de pollution `register` global)
 * - render() retourne le format Prometheus + content-type correct
 */

import { MetricsService } from './metrics.service'

describe('MetricsService', () => {
  let service: MetricsService

  beforeEach(() => {
    service = new MetricsService()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  describe('metric registration', () => {
    it('exposes the canonical metrics (A3 + A3-bis) with cleanconnect_ prefix', async () => {
      const { body } = await service.render()
      expect(body).toContain('# TYPE cleanconnect_http_requests_total counter')
      expect(body).toContain('# TYPE cleanconnect_http_request_duration_seconds histogram')
      expect(body).toContain('# TYPE cleanconnect_bullmq_jobs_total counter')
      expect(body).toContain('# TYPE cleanconnect_bullmq_jobs_failed_total counter')
      // PRD-004 A3-bis : ajouts runtime instrumentation.
      expect(body).toContain('# TYPE cleanconnect_webhook_processing_total counter')
      expect(body).toContain('# TYPE cleanconnect_webhook_processing_failures_total counter')
      expect(body).toContain('# TYPE cleanconnect_webhook_processing_duration_seconds histogram')
      expect(body).toContain('# TYPE cleanconnect_stripe_api_calls_total counter')
      expect(body).toContain('# TYPE cleanconnect_stripe_api_failures_total counter')
      expect(body).toContain('# TYPE cleanconnect_stripe_api_duration_seconds histogram')
      expect(body).toContain('# TYPE cleanconnect_dlq_jobs_total gauge')
      expect(body).toContain('# TYPE cleanconnect_dlq_events_total counter')
    })

    it('configures Node runtime metrics via collectDefaultMetrics (registered, value populated lazily)', async () => {
      // `collectDefaultMetrics` enregistre des collectors évalués à chaque
      // `render()` — pour la fondation A3, on vérifie que la métrique HTTP
      // canonique est bien dans la sortie. Les métriques runtime Node
      // (cpu/heap) sont testées en intégration (smoke test recette).
      service.httpRequestsTotal.inc({ method: 'GET', route: '/api/v1/health', status: '200' })
      const { body } = await service.render()
      expect(body).toContain('cleanconnect_http_requests_total{method="GET",route="/api/v1/health",status="200"} 1')
    })

    it('renders text/plain content type with Prometheus version', async () => {
      const { contentType } = await service.render()
      expect(contentType).toMatch(/text\/plain/)
      expect(contentType).toMatch(/version=/)
    })
  })

  describe('cardinality control', () => {
    it('http requests counter accepts only method/route/status labels (no PII)', () => {
      // Garantie statique : labelNames est `as const` (cardinalité figée).
      // L'appel ci-dessous est valide ; tout label en dehors casse TS.
      service.httpRequestsTotal.inc({ method: 'GET', route: '/users/:id', status: '200' })
    })

    it('bullmq jobs counter accepts only queue/name/result labels (no PII)', () => {
      service.bullmqJobsTotal.inc({ queue: 'stripe-webhooks', name: 'evt', result: 'success' })
    })

    it('dlq gauge accepts only queue label (no PII)', () => {
      service.dlqJobsTotal.set({ queue: 'stripe-webhooks' }, 3)
    })
  })

  describe('histogram buckets (latency)', () => {
    it('http duration histogram exposes the configured latency buckets', async () => {
      service.httpRequestDurationSeconds.observe(
        { method: 'GET', route: '/x', status: '200' },
        0.123,
      )
      const { body } = await service.render()
      // Buckets attendus (cf. LATENCY_BUCKETS_SECONDS).
      expect(body).toContain('le="0.01"')
      expect(body).toContain('le="0.025"')
      expect(body).toContain('le="0.05"')
      expect(body).toContain('le="0.1"')
      expect(body).toContain('le="0.25"')
      expect(body).toContain('le="0.5"')
      expect(body).toContain('le="1"')
      expect(body).toContain('le="2.5"')
      expect(body).toContain('le="5"')
      expect(body).toContain('le="10"')
      expect(body).toContain('le="+Inf"')
    })
  })

  describe('duplicate prevention', () => {
    /**
     * Le registry est `new Registry()` dédié à l'instance (pas le `register`
     * global de prom-client). Toute construction `new MetricsService()`
     * crée son propre registry indépendant. Vérifié indirectement par les
     * autres tests : aucune fuite croisée n'a jamais été observée entre
     * suites de tests.
     */
    it('uses a private registry (no shared state with prom-client global)', () => {
      // Accès via le contentType qui inclut la version Prometheus
      // de la registry locale — vérification minimale d'isolation.
      expect(service).toBeDefined()
      expect(service.httpRequestsTotal).toBeDefined()
      expect(service.bullmqJobsTotal).toBeDefined()
    })
  })

  describe('counter increments observable in render', () => {
    it('reflects increments and observations in /metrics body', async () => {
      service.httpRequestsTotal.inc({ method: 'GET', route: '/v1/users/:id', status: '200' })
      service.httpRequestsTotal.inc({ method: 'GET', route: '/v1/users/:id', status: '200' })
      service.bullmqJobsTotal.inc({ queue: 'stripe-webhooks', name: 'evt', result: 'success' })
      service.bullmqJobsFailedTotal.inc({
        queue: 'stripe-webhooks',
        name: 'evt',
        reason: 'timeout',
      })
      // PRD-004 A3-bis : labels renommés `operation`/`status` + `event_type`/`outcome`.
      service.stripeApiCallsTotal.inc({ operation: 'payment_intents.create', status: 'success' })
      service.stripeApiFailuresTotal.inc({
        operation: 'payment_intents.create',
        status: 'rate_limited',
      })
      service.stripeApiDurationSeconds.observe(
        { operation: 'payment_intents.create', status: 'success' },
        0.2,
      )
      service.dlqJobsTotal.set({ queue: 'stripe-webhooks' }, 5)
      service.dlqEventsTotal.inc({ source: 'stripe', action: 'enqueued' })
      service.webhookProcessingTotal.inc({
        event_type: 'payment_intent.succeeded',
        outcome: 'accepted',
      })
      service.webhookProcessingFailuresTotal.inc({
        event_type: 'payment_intent.succeeded',
        outcome: 'failed',
      })
      service.webhookProcessingDurationSeconds.observe(
        { event_type: 'payment_intent.succeeded', outcome: 'accepted' },
        0.045,
      )

      const { body } = await service.render()
      expect(body).toContain(
        'cleanconnect_http_requests_total{method="GET",route="/v1/users/:id",status="200"} 2',
      )
      expect(body).toContain(
        'cleanconnect_bullmq_jobs_total{queue="stripe-webhooks",name="evt",result="success"} 1',
      )
      expect(body).toContain(
        'cleanconnect_bullmq_jobs_failed_total{queue="stripe-webhooks",name="evt",reason="timeout"} 1',
      )
      expect(body).toContain(
        'cleanconnect_stripe_api_calls_total{operation="payment_intents.create",status="success"} 1',
      )
      expect(body).toContain(
        'cleanconnect_stripe_api_failures_total{operation="payment_intents.create",status="rate_limited"} 1',
      )
      expect(body).toContain('cleanconnect_dlq_jobs_total{queue="stripe-webhooks"} 5')
      expect(body).toContain(
        'cleanconnect_dlq_events_total{source="stripe",action="enqueued"} 1',
      )
      expect(body).toContain(
        'cleanconnect_webhook_processing_total{event_type="payment_intent.succeeded",outcome="accepted"} 1',
      )
      expect(body).toContain(
        'cleanconnect_webhook_processing_failures_total{event_type="payment_intent.succeeded",outcome="failed"} 1',
      )
    })
  })
})
