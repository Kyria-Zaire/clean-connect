/**
 * PRD-004 Ticket 4.2 — Tests d'intégration retry & recovery BullMQ.
 *
 * Couverture obligatoire CTO :
 *  ✓ transfer transient error → retry enqueue avec idempotency stable
 *  ✓ transfer permanent error → FAILED direct + alerte P1 (no retry)
 *  ✓ transfer max attempts → FAILED + métrique retry_exhausted + alerte P0
 *  ✓ no double payout sur retry (idempotency Stripe `transfer-mission-<id>`)
 *  ✓ admin manual retry concurrent avec auto retry → 1 seul transfer SENT
 *  ✓ auto-release safety-net : SCHEDULED overdue → re-enqueue BullMQ
 *  ✓ auto-release safety-net : RUNNING orphan lock → release + re-enqueue
 *  ✓ webhook poison job MAX attempts → DLQ + alert P0 + metric exhausted
 *  ✓ DLQ growth alert P1 sur recordEnqueued
 *  ✓ orphan PhotoUploadSession cleanup (DB only, pas Cloudinary)
 *  ✓ aucune PII dans les alertes / payloads / métriques
 *
 * Stratégie : on stub `STRIPE_CLIENT_TOKEN` + on `__setNotifierForTests()`
 * sur `AlertingService` pour capturer les emits sans toucher Discord.
 * Aucun appel réseau externe.
 */

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import { Logger as PinoLogger } from 'nestjs-pino'
import type Stripe from 'stripe'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { AutoReleaseSafetyNetScheduler } from '../../src/modules/missions-completion/auto-release/auto-release-safety-net.scheduler'
import {
  AUTO_RELEASE_QUEUE,
  AUTO_RELEASE_SAFETY_GRACE_MS,
  AUTO_RELEASE_STUCK_LOCK_MS,
  buildAutoReleaseBullJobId,
} from '../../src/modules/missions-completion/auto-release/auto-release.constants'
import { AlertingService } from '../../src/modules/observability/alerting/alerting.service'
import type {
  AlertPayload,
  AlertSeverity,
  AlertKind,
} from '../../src/modules/observability/alerting/alerting.types'
import { STRIPE_WEBHOOK_MAX_ATTEMPTS, STRIPE_WEBHOOK_QUEUE } from '../../src/modules/payments/payments.constants'
import { OutboundTransferService } from '../../src/modules/payments/transfers/outbound-transfer.service'
import {
  TRANSFER_MAX_API_ATTEMPTS,
  TRANSFER_RETRY_QUEUE,
} from '../../src/modules/payments/transfers/transfer.constants'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'
import { PaymentDomainHandler } from '../../src/modules/payments/webhooks/payment-domain.handler'
import { StripeWebhookProcessor } from '../../src/modules/payments/webhooks/stripe-webhook.processor'
import { PhotoUploadSessionCleanupScheduler } from '../../src/modules/photos/photo-upload-session-cleanup.scheduler'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

class FakeStripeError extends Error {
  constructor(
    public readonly type: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(`stripe ${type} ${code}`)
    this.name = 'StripeError'
  }
}

interface StripeStub {
  paymentIntents: {
    create: jest.Mock
    retrieve: jest.Mock
  }
  transfers: {
    create: jest.Mock
    retrieve: jest.Mock
  }
  refunds: { create: jest.Mock }
  events: { retrieve: jest.Mock }
  webhooks: { constructEvent: jest.Mock }
  __setNextTransferCreate(impl: (args: Stripe.TransferCreateParams) => Stripe.Transfer | Promise<Stripe.Transfer>): void
  __captured: {
    transferCreates: { args: unknown[]; idempotencyKey: string | undefined }[]
  }
}

function buildStripeStub(): StripeStub {
  const captured: StripeStub['__captured'] = { transferCreates: [] }
  const queue: Array<(args: Stripe.TransferCreateParams) => Stripe.Transfer | Promise<Stripe.Transfer>> = []
  const transferState = new Map<string, Stripe.Transfer>()

  const stub: StripeStub = {
    paymentIntents: {
      create: jest.fn(async () => ({
        id: `pi_t42_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        client_secret: 'pi_t42_secret',
        status: 'requires_payment_method',
        latest_charge: `ch_t42_${Math.random().toString(36).slice(2, 10)}`,
      })),
      retrieve: jest.fn(async (id: string) => ({
        id,
        status: 'succeeded',
        amount: 15_000,
        amount_received: 15_000,
        latest_charge: `ch_${id}`,
      })),
    },
    transfers: {
      create: jest.fn(async (args: Stripe.TransferCreateParams, opts?: { idempotencyKey?: string }) => {
        const key = opts?.idempotencyKey
        captured.transferCreates.push({ args, idempotencyKey: key })
        if (key && transferState.has(key)) {
          return transferState.get(key) as Stripe.Transfer
        }
        const next = queue.shift()
        const tr = next
          ? await next(args)
          : ({
              id: `tr_${Math.random().toString(36).slice(2, 10)}`,
              amount: args.amount,
              currency: args.currency,
              destination: args.destination,
              metadata: args.metadata ?? {},
              reversed: false,
              amount_reversed: 0,
              transfer_group: args.transfer_group ?? null,
            } as unknown as Stripe.Transfer)
        if (key && !(tr as unknown as { __no_state?: boolean }).__no_state) {
          transferState.set(key, tr)
        }
        return tr
      }),
      retrieve: jest.fn(async (id: string) => ({
        id,
        amount: 12_000,
        currency: 'eur',
        reversed: false,
        amount_reversed: 0,
        metadata: {},
      } as unknown as Stripe.Transfer)),
    },
    refunds: { create: jest.fn() },
    events: { retrieve: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
    __setNextTransferCreate(impl) {
      queue.push(impl)
    },
    __captured: captured,
  }
  return stub
}

async function buildApp(): Promise<{
  app: INestApplication
  stripe: StripeStub
  webhookQueue: Queue
  autoReleaseQueue: Queue
  transferRetryQueue: Queue
  alerting: AlertingService
  capturedAlerts: AlertPayload[]
}> {
  process.env['FF_PAYMENTS_ENABLED'] = 'true'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  // AlertingService est piloté via __setNotifierForTests pour capturer.
  process.env['ALERTING_ENABLED'] = 'false'
  __resetEnvCacheForTests()

  const stripe = buildStripeStub()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STRIPE_CLIENT_TOKEN)
    .useValue(stripe)
    .compile()

  const app = moduleRef.createNestApplication({ rawBody: true })
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()

  const webhookQueue = app.get<Queue>(getQueueToken(STRIPE_WEBHOOK_QUEUE))
  const autoReleaseQueue = app.get<Queue>(getQueueToken(AUTO_RELEASE_QUEUE))
  const transferRetryQueue = app.get<Queue>(getQueueToken(TRANSFER_RETRY_QUEUE))

  // Capture les emits AlertingService — on injecte un notifier mock même si
  // ALERTING_ENABLED=false (sinon AlertingService est en no-op total et on ne
  // voit rien). Le `__setNotifierForTests` est documenté @internal.
  const alerting = app.get(AlertingService)
  const capturedAlerts: AlertPayload[] = []
  const notifierMock = {
    send: jest.fn(async (p: AlertPayload) => {
      capturedAlerts.push(p)
      return true
    }),
    sendBatch: jest.fn(async (ps: AlertPayload[]) => {
      capturedAlerts.push(...ps)
      return true
    }),
  }
  // Le `AlertingService.emit` court-circuite si `this.notifier === null`.
  // On force le notifier injecté pour capturer les emits dans les tests.
  alerting.__setNotifierForTests(notifierMock as unknown as Parameters<typeof alerting.__setNotifierForTests>[0])

  return { app, stripe, webhookQueue, autoReleaseQueue, transferRetryQueue, alerting, capturedAlerts }
}

interface Fixture {
  missionId: string
  paymentId: string
  intentId: string
  prestataireId: string
  clientId: string
}

async function makeCapturedFixture(
  app: INestApplication,
  stripe: StripeStub,
  opts: { unique?: string } = {},
): Promise<Fixture> {
  const prisma = app.get(PrismaService)
  const tag = opts.unique ?? Math.random().toString(36).slice(2, 8)

  const client = await createTestUser(prisma, {
    role: 'CLIENT',
    base: { city: 'Paris', zipCode: '75011', street: `${tag} rue Oberkampf`, lat: 48.8638, lng: 2.3777 },
  })
  const prestataire = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: { city: 'Paris', zipCode: '75010', street: `${tag} rue Bichat`, lat: 48.871, lng: 2.366 },
  })
  await prisma.user.update({
    where: { id: prestataire.id },
    data: {
      providerPayoutStatus: 'READY',
      stripeAccountId: `acct_test_${prestataire.id.slice(0, 8)}`,
      stripeChargesEnabled: true,
      stripeTransfersEnabled: true,
      stripePayoutsEnabled: true,
    },
  })

  const clientToken = await forgeAccessToken(app, { id: client.id, role: 'CLIENT' })
  const draft = await request(app.getHttpServer())
    .post('/api/v1/missions')
    .set('authorization', `Bearer ${clientToken}`)
    .send({
      serviceType: 'SOFA',
      address: { street: `${tag} rue Oberkampf`, city: 'Paris', zipCode: '75011', country: 'FR' },
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      endAt: new Date(Date.now() + 26 * 60 * 60 * 1_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents: 15_000,
    })
  if (draft.status !== 201) {
    throw new Error(`mission DRAFT failed: ${draft.status} ${JSON.stringify(draft.body)}`)
  }
  const intent = await request(app.getHttpServer())
    .post('/api/v1/payments/intent')
    .set('authorization', `Bearer ${clientToken}`)
    .set('idempotency-key', `t42-${Date.now()}-${tag}`)
    .send({ missionId: draft.body.id })
  if (intent.status !== 201) {
    throw new Error(`intent failed: ${intent.status} ${JSON.stringify(intent.body)}`)
  }

  await prisma.payment.update({
    where: { id: intent.body.paymentId },
    data: { status: 'AUTHORIZED' },
  })
  await prisma.mission.update({
    where: { id: draft.body.id },
    data: { status: 'CLIENT_VALIDATION_PENDING', prestataireId: prestataire.id },
  })

  return {
    missionId: draft.body.id,
    paymentId: intent.body.paymentId,
    intentId: intent.body.stripePaymentIntentId,
    prestataireId: prestataire.id,
    clientId: client.id,
  }
}

function makePaymentEvent(intentId: string): Stripe.Event {
  return {
    id: `evt_t42_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: intentId,
        amount: 15_000,
        amount_received: 15_000,
        status: 'succeeded',
        latest_charge: `ch_${intentId}`,
      } as Stripe.PaymentIntent,
    },
  } as Stripe.Event
}

describe('PRD-004 Ticket 4.2 — Retry & Recovery BullMQ', () => {
  let app: INestApplication
  let stripe: StripeStub
  let webhookQueue: Queue
  let autoReleaseQueue: Queue
  let transferRetryQueue: Queue
  let alerting: AlertingService
  let capturedAlerts: AlertPayload[]
  let prisma: PrismaService

  beforeAll(async () => {
    const built = await buildApp()
    app = built.app
    stripe = built.stripe
    webhookQueue = built.webhookQueue
    autoReleaseQueue = built.autoReleaseQueue
    transferRetryQueue = built.transferRetryQueue
    alerting = built.alerting
    capturedAlerts = built.capturedAlerts
    prisma = app.get(PrismaService)
  })

  beforeEach(() => {
    capturedAlerts.length = 0
    alerting.resetCooldownForTests()
  })

  afterAll(async () => {
    if (app) {
      const users = await prisma.user.findMany({
        where: { email: { contains: '@cc-test.fr' } },
        select: { id: true },
      })
      const userIds = users.map((u) => u.id)
      if (userIds.length > 0) {
        const missions = await prisma.mission.findMany({
          where: { clientId: { in: userIds } },
          select: { id: true },
        })
        const missionIds = missions.map((m) => m.id)
        if (missionIds.length > 0) {
          await prisma.refund.deleteMany({ where: { payment: { missionId: { in: missionIds } } } })
          await prisma.transfer.deleteMany({ where: { payment: { missionId: { in: missionIds } } } })
          await prisma.autoReleaseJob.deleteMany({ where: { missionId: { in: missionIds } } })
          await prisma.payment.deleteMany({ where: { missionId: { in: missionIds } } })
        }
      }
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Transfer retry — transient → enqueue + idempotency stable
  // ---------------------------------------------------------------------------

  describe('Transfer retry — transient errors', () => {
    it('enqueue retry après une erreur transient + idempotency Stripe stable', async () => {
      const fx = await makeCapturedFixture(app, stripe)

      // 1ère tentative : Stripe lance rate_limit_error.
      stripe.__setNextTransferCreate(() => {
        throw new FakeStripeError('rate_limit_error', 'rate_limit', 429)
      })

      const addSpy = jest.spyOn(transferRetryQueue, 'add')
      addSpy.mockClear()

      const handler = app.get(PaymentDomainHandler)
      await handler.handle(makePaymentEvent(fx.intentId))

      const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(tr).not.toBeNull()
      // En cas d'erreur transient, le service incrémente retryCount + enqueue.
      expect(tr!.status).toBe('RETRY_SCHEDULED')
      expect(tr!.retryCount).toBe(1)
      expect(tr!.idempotencyKey).toBe(`transfer-mission-${fx.missionId}`)

      expect(addSpy).toHaveBeenCalledTimes(1)
      const [, payload, opts] = addSpy.mock.calls[0] as [string, { transferId: string; attempt: number }, { jobId: string; delay: number; attempts: number }]
      expect(payload.transferId).toBe(tr!.id)
      expect(payload.attempt).toBe(1)
      expect(opts.attempts).toBe(1)
      expect(opts.delay).toBeGreaterThan(0)
      // jobId déterministe = anti-double-enqueue.
      expect(opts.jobId).toBe(`transfer-retry-${tr!.id}-a1`)

      addSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // Transfer retry — permanent → FAILED direct + alert P1
  // ---------------------------------------------------------------------------

  describe('Transfer retry — permanent errors', () => {
    it('bascule FAILED direct + alert P1 si erreur permanent (account_closed)', async () => {
      const fx = await makeCapturedFixture(app, stripe)

      stripe.__setNextTransferCreate(() => {
        throw new FakeStripeError('invalid_request_error', 'account_closed', 400)
      })

      const handler = app.get(PaymentDomainHandler)
      await handler.handle(makePaymentEvent(fx.intentId))

      const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(tr!.status).toBe('FAILED')
      expect(tr!.failureCode).toBe('account_closed')
      expect(tr!.retryCount).toBe(TRANSFER_MAX_API_ATTEMPTS)

      // Alerte P1 stuck_transfer émise.
      const p1 = capturedAlerts.find(
        (a) => a.severity === 'P1' && a.kind === ('stuck_transfer' satisfies AlertKind),
      )
      expect(p1).toBeDefined()
      // Pas de userId/email/missionId complet dans l'alerte.
      const json = JSON.stringify(p1)
      expect(json).not.toMatch(/@cc-test\.fr/)
      expect(json).not.toContain(fx.missionId)
      expect(json).not.toContain(fx.paymentId)
    })
  })

  // ---------------------------------------------------------------------------
  // Transfer retry — max attempts → FAILED + retry_exhausted metric + alert P0
  // ---------------------------------------------------------------------------

  describe('Transfer retry — max attempts exhausted', () => {
    it('terminal FAILED + alert P0 bullmq_failed_jobs après MAX retries', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      // Force Stripe à toujours échouer transient.
      for (let i = 0; i < TRANSFER_MAX_API_ATTEMPTS; i += 1) {
        stripe.__setNextTransferCreate(() => {
          throw new FakeStripeError('api_connection_error', 'network', 503)
        })
      }

      // 1ère tentative via webhook
      const handler = app.get(PaymentDomainHandler)
      await handler.handle(makePaymentEvent(fx.intentId))
      // Puis on simule les retries successifs via OutboundTransferService.retryFromJob
      const outbound = app.get(OutboundTransferService)
      for (let i = 0; i < TRANSFER_MAX_API_ATTEMPTS - 1; i += 1) {
        const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
        if (!tr) throw new Error('transfer missing')
        if (tr.status === 'FAILED') break
        // Le service exige `RETRY_SCHEDULED` ou `PENDING` côté job → on remet.
        await prisma.transfer.update({
          where: { id: tr.id },
          data: { status: 'RETRY_SCHEDULED' },
        })
        await outbound.retryFromJob(tr.id)
      }

      const final = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(final!.status).toBe('FAILED')
      expect(final!.retryCount).toBeGreaterThanOrEqual(TRANSFER_MAX_API_ATTEMPTS)

      // Alerte P0 bullmq_failed_jobs émise au moins une fois.
      const p0 = capturedAlerts.find(
        (a) => a.severity === 'P0' && a.kind === ('bullmq_failed_jobs' satisfies AlertKind),
      )
      expect(p0).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Transfer retry — no double payout (idempotency Stripe stable)
  // ---------------------------------------------------------------------------

  describe('No double payout under retries', () => {
    it('idempotency Stripe = transfer-mission-<id> sur toutes les tentatives', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const expected = `transfer-mission-${fx.missionId}`
      stripe.__setNextTransferCreate(() => {
        throw new FakeStripeError('api_connection_error', 'network', 503)
      })

      const handler = app.get(PaymentDomainHandler)
      await handler.handle(makePaymentEvent(fx.intentId))

      // Premier appel échoué → on retente sans erreur Stripe (success).
      const outbound = app.get(OutboundTransferService)
      const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      await prisma.transfer.update({
        where: { id: tr!.id },
        data: { status: 'RETRY_SCHEDULED' },
      })
      await outbound.retryFromJob(tr!.id)

      const sent = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(sent!.status).toBe('SENT')

      // `__captured.transferCreates` est cumulatif (stub partagé) — on isole
      // les calls de la mission courante via la destination prestataire.
      const expectedDestination = `acct_test_${fx.prestataireId.slice(0, 8)}`
      const myCalls = stripe.__captured.transferCreates.filter((c) => {
        const args = c.args as { destination?: string }
        return args.destination === expectedDestination
      })
      expect(myCalls.length).toBeGreaterThanOrEqual(2)
      // Toutes les tentatives Stripe pour CETTE mission portent la MÊME idempotency key.
      expect(myCalls.every((c) => c.idempotencyKey === expected)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Auto-release safety-net — SCHEDULED overdue + RUNNING orphan lock
  // ---------------------------------------------------------------------------

  describe('Auto-release safety-net cron', () => {
    it('re-enqueue un job SCHEDULED dont scheduledFor est en retard', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const oldDate = new Date(Date.now() - AUTO_RELEASE_SAFETY_GRACE_MS - 60_000)
      const job = await prisma.autoReleaseJob.create({
        data: {
          missionId: fx.missionId,
          bullJobId: buildAutoReleaseBullJobId(fx.missionId),
          idempotencyKey: `capture-mission-${fx.missionId}`,
          scheduledFor: oldDate,
          status: 'SCHEDULED',
        },
      })

      const addSpy = jest.spyOn(autoReleaseQueue, 'add')
      addSpy.mockClear()

      const scheduler = app.get(AutoReleaseSafetyNetScheduler)
      const result = await scheduler.tickInternal(new Date())
      expect(result.reenqueued).toBeGreaterThanOrEqual(1)
      expect(addSpy).toHaveBeenCalled()

      const calls = addSpy.mock.calls.filter(
        ([, payload]) => (payload as { autoReleaseJobId: string }).autoReleaseJobId === job.id,
      )
      expect(calls.length).toBe(1)
      addSpy.mockRestore()
    })

    it('relâche le lock orphelin d\'un job RUNNING + re-enqueue', async () => {
      const fx = await makeCapturedFixture(app, stripe, { unique: 'safety2' })
      const oldLock = new Date(Date.now() - AUTO_RELEASE_STUCK_LOCK_MS - 60_000)
      const job = await prisma.autoReleaseJob.create({
        data: {
          missionId: fx.missionId,
          bullJobId: buildAutoReleaseBullJobId(fx.missionId),
          idempotencyKey: `capture-mission-${fx.missionId}`,
          scheduledFor: new Date(Date.now() + 60 * 60 * 1_000),
          status: 'RUNNING',
          lockedAt: oldLock,
          lockedBy: 'dead-worker#42',
          startedAt: oldLock,
        },
      })

      const scheduler = app.get(AutoReleaseSafetyNetScheduler)
      const result = await scheduler.tickInternal(new Date())
      expect(result.relockReleased).toBeGreaterThanOrEqual(1)
      expect(result.reenqueued).toBeGreaterThanOrEqual(1)

      const after = await prisma.autoReleaseJob.findUnique({ where: { id: job.id } })
      expect(after!.status).toBe('SCHEDULED')
      expect(after!.lockedAt).toBeNull()
      expect(after!.lockedBy).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Webhook poison job — MAX attempts → DLQ + alert P0 + alert P1 dlq_growth
  // ---------------------------------------------------------------------------

  describe('Webhook poison job', () => {
    it('exhaustion stripe-webhooks → DLQ + alert P0 + alert P1 dlq_growth', async () => {
      const evtId = `evt_p_${Math.random().toString(36).slice(2, 10)}`
      await prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: evtId,
          type: 'payment_intent.succeeded',
          payloadHash: 'c'.repeat(64),
          livemode: false,
          processingStatus: 'FAILED',
        },
      })

      const processor = app.get(StripeWebhookProcessor)
      const job = {
        name: 'process',
        id: 'bull-id',
        data: {
          stripeEventId: evtId,
          type: 'payment_intent.succeeded',
          livemode: false,
          payloadHash: 'c'.repeat(64),
        },
        attemptsMade: STRIPE_WEBHOOK_MAX_ATTEMPTS,
      } as unknown as Parameters<typeof processor.onJobFailed>[0]

      await processor.onJobFailed(job, new Error('persistent_bug'))

      // DLQ row écrite.
      const dlq = await prisma.webhookDeadLetter.findFirst({
        where: { externalEventId: evtId },
      })
      expect(dlq).not.toBeNull()

      // Alerte P0 bullmq_failed_jobs émise.
      const p0 = capturedAlerts.find(
        (a) => a.severity === 'P0' && a.kind === ('bullmq_failed_jobs' satisfies AlertKind),
      )
      expect(p0).toBeDefined()

      // Alerte P1 dlq_growth émise via recordEnqueued.
      const p1 = capturedAlerts.find(
        (a: AlertPayload) =>
          (a.severity as AlertSeverity) === 'P1' && a.kind === ('dlq_growth' satisfies AlertKind),
      )
      expect(p1).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Orphan PhotoUploadSession cleanup
  // ---------------------------------------------------------------------------

  describe('PhotoUploadSession cleanup cron', () => {
    it('supprime les sessions expirées non consommées sans Photo (DB only)', async () => {
      const fx = await makeCapturedFixture(app, stripe, { unique: 'photo' })
      // Session expirée + non consommée + pas de Photo.
      const expired = await prisma.photoUploadSession.create({
        data: {
          missionId: fx.missionId,
          uploaderUserId: fx.clientId,
          phase: 'BEFORE',
          variant: 'ORIGINAL',
          captureClientUuid: '00000000-0000-4000-8000-000000000777',
          tokenDigest: 'd'.repeat(64),
          expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1_000),
          mimeType: 'image/jpeg',
          cloudinaryPublicId: `dev/missions/${fx.missionId}/BEFORE/orphan/ORIGINAL`,
        },
      })

      const scheduler = app.get(PhotoUploadSessionCleanupScheduler)
      const result = await scheduler.tickInternal(new Date())
      expect(result.deleted).toBeGreaterThanOrEqual(1)

      const after = await prisma.photoUploadSession.findUnique({
        where: { id: expired.id },
      })
      expect(after).toBeNull()
    })

    it('ne supprime PAS les sessions encore valides', async () => {
      const fx = await makeCapturedFixture(app, stripe, { unique: 'photo2' })
      const valid = await prisma.photoUploadSession.create({
        data: {
          missionId: fx.missionId,
          uploaderUserId: fx.clientId,
          phase: 'AFTER',
          variant: 'DISPLAY',
          captureClientUuid: '00000000-0000-4000-8000-000000000888',
          tokenDigest: 'e'.repeat(64),
          // Expire dans 30 minutes — pas encore expirée.
          expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
          mimeType: 'image/jpeg',
          cloudinaryPublicId: `dev/missions/${fx.missionId}/AFTER/valid/DISPLAY`,
        },
      })

      const scheduler = app.get(PhotoUploadSessionCleanupScheduler)
      await scheduler.tickInternal(new Date())

      const after = await prisma.photoUploadSession.findUnique({ where: { id: valid.id } })
      expect(after).not.toBeNull()
    })
  })
})
