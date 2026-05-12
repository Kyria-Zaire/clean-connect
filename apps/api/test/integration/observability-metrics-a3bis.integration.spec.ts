/**
 * Tests d'intégration — PRD-004 Ticket 4.1 Build A3-bis (Metrics wiring).
 *
 * Couvre les flux runtime réels (HTTP + DB + Stripe HMAC + BullMQ) pour
 * vérifier que les compteurs Prometheus s'incrémentent bien :
 *   - Webhook accepté (HMAC valide + DB insert + enqueue)
 *   - Webhook rejeté (signature invalide)
 *   - Webhook replayé (event_id déjà présent → 202 idempotent)
 *   - Replay DLQ (admin) → counter `dlq_events_total{action="replayed"}`
 *   - Stripe API call (webhooks.construct_event) instrumentée
 *
 * Prérequis : Postgres + Redis test (cf. db:test:up).
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import { createHmac } from 'node:crypto'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { MetricsService } from '../../src/modules/observability/metrics/metrics.service'
import { PaymentsWebhookService } from '../../src/modules/payments/webhooks/payments-webhook.service'

jest.setTimeout(180_000)

const WEBHOOK_SECRET = 'whsec_a3bis_metrics_integration_minlen_32xx'
const ROUTE = '/api/v1/webhooks/stripe'

function buildSignedRequest(opts: {
  eventId: string
  type?: string
  livemode?: boolean
  timestampSeconds?: number
}): { rawBody: Buffer; signature: string } {
  const ts = opts.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const event = {
    id: opts.eventId,
    object: 'event',
    type: opts.type ?? 'payment_intent.succeeded',
    api_version: '2025-02-24.acacia',
    livemode: opts.livemode ?? false,
    created: ts,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'pi_test_a3bis' } },
  }
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8')
  const signedPayload = `${ts}.${rawBody.toString('utf8')}`
  const hmac = createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex')
  return { rawBody, signature: `t=${ts},v1=${hmac}` }
}

async function buildApp(): Promise<INestApplication> {
  process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  process.env['STRIPE_API_VERSION'] = '2025-02-24.acacia'
  process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] = '300'
  process.env['FF_PAYMENTS_ENABLED'] = 'true'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  __resetEnvCacheForTests()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication({ rawBody: true })
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

/** Petit helper — lit la section Prometheus rendue par MetricsService. */
async function renderMetrics(app: INestApplication): Promise<string> {
  return (await app.get(MetricsService).render()).body
}

describe('PRD-004 A3-bis — runtime metrics wiring', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function cleanupEvent(stripeEventId: string): Promise<void> {
    try {
      await prisma.stripeWebhookEvent.delete({ where: { stripeEventId } })
    } catch {
      // déjà absent
    }
  }

  async function cleanupDeadLetter(externalEventId: string): Promise<void> {
    try {
      await prisma.webhookDeadLetter.deleteMany({ where: { externalEventId } })
    } catch {
      // ignore
    }
  }

  it('webhook accepté : incrémente webhook_processing_total{outcome=accepted} + stripe_api_calls_total{webhooks.construct_event,success}', async () => {
    const eventId = `evt_a3bis_accepted_${Date.now()}`
    const { rawBody, signature } = buildSignedRequest({ eventId })

    const res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody.toString('utf8'))
    expect(res.status).toBe(202)

    const body = await renderMetrics(app)
    expect(body).toMatch(
      /cleanconnect_webhook_processing_total\{event_type="payment_intent.succeeded",outcome="accepted"\}\s+\d+/,
    )
    expect(body).toMatch(
      /cleanconnect_stripe_api_calls_total\{operation="webhooks.construct_event",status="success"\}\s+\d+/,
    )
    // Failures totals ne doit pas augmenter sur ce flux nominal.
    expect(body).toMatch(
      /cleanconnect_webhook_processing_duration_seconds_count\{event_type="payment_intent.succeeded",outcome="accepted"\}\s+\d+/,
    )

    await cleanupEvent(eventId)
  })

  it('signature rejetée : incrémente webhook_processing_total{outcome=rejected} + stripe_api_failures_total{invalid_signature}', async () => {
    const eventId = `evt_a3bis_rejected_${Date.now()}`
    const { rawBody } = buildSignedRequest({ eventId })

    const res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('stripe-signature', 't=1700000000,v1=deadbeef')
      .set('content-type', 'application/json')
      .send(rawBody.toString('utf8'))
    expect(res.status).toBe(400)

    const body = await renderMetrics(app)
    expect(body).toMatch(
      /cleanconnect_webhook_processing_total\{event_type="unknown",outcome="rejected"\}\s+\d+/,
    )
    expect(body).toMatch(
      /cleanconnect_webhook_processing_failures_total\{event_type="unknown",outcome="rejected"\}\s+\d+/,
    )
    expect(body).toMatch(
      /cleanconnect_stripe_api_failures_total\{operation="webhooks.construct_event",status="invalid_signature"\}\s+\d+/,
    )
  })

  it('replay détecté : incrémente webhook_processing_total{outcome=replayed}', async () => {
    const eventId = `evt_a3bis_replayed_${Date.now()}`
    const { rawBody, signature } = buildSignedRequest({ eventId })

    // 1er passage — accepted
    let res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody.toString('utf8'))
    expect(res.status).toBe(202)
    expect(res.body.idempotent).toBe(false)

    // 2e passage — même event_id → 202 idempotent (replay)
    res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody.toString('utf8'))
    expect(res.status).toBe(202)
    expect(res.body.idempotent).toBe(true)

    const body = await renderMetrics(app)
    expect(body).toMatch(
      /cleanconnect_webhook_processing_total\{event_type="payment_intent.succeeded",outcome="replayed"\}\s+\d+/,
    )

    await cleanupEvent(eventId)
  })

  it('replay DLQ admin : incrémente dlq_events_total{action=replayed}', async () => {
    const eventId = `evt_a3bis_dlq_${Date.now()}`
    const { rawBody, signature } = buildSignedRequest({ eventId, type: 'transfer.created' })

    // Pose l'event en DB (PENDING) — comme si la signature était passée.
    const res = await request(app.getHttpServer())
      .post(ROUTE)
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody.toString('utf8'))
    expect(res.status).toBe(202)

    // Crée une ligne DLQ manuellement (simule le processor failed exhausted)
    const dlq = await prisma.webhookDeadLetter.create({
      data: {
        source: 'STRIPE',
        externalEventId: eventId,
        payloadHash: 'dummyhash_'.padEnd(64, '0').slice(0, 64),
        errorMessage: 'simulated dlq for a3bis test',
        attempts: 5,
        lastAttemptAt: new Date(),
      },
    })

    // Invoque replay directement via le service (le contrôleur admin
    // requiert un JWT admin que ce test n'a pas — on isole l'instrumentation).
    const svc = app.get(PaymentsWebhookService)
    await svc.replayStripeDeadLetter(dlq.id)

    const body = await renderMetrics(app)
    expect(body).toMatch(
      /cleanconnect_dlq_events_total\{source="stripe",action="replayed"\}\s+\d+/,
    )

    await cleanupDeadLetter(eventId)
    await cleanupEvent(eventId)
  })

  it('replay DLQ inexistante : incrémente dlq_events_total{action=replay_failed} + NotFoundException', async () => {
    const svc = app.get(PaymentsWebhookService)
    // Le message Nest est "Not Found Exception" — le code métier est dans
    // `exception.getResponse().error`. On vérifie la classe + le code.
    await expect(
      svc.replayStripeDeadLetter('00000000-0000-4000-8000-000000000fff'),
    ).rejects.toMatchObject({
      response: { error: 'WEBHOOK_DLQ_NOT_FOUND' },
    })

    const body = await renderMetrics(app)
    expect(body).toMatch(
      /cleanconnect_dlq_events_total\{source="stripe",action="replay_failed"\}\s+\d+/,
    )
  })
})
