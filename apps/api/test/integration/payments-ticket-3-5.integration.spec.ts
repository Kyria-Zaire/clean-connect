/**
 * PRD-003 Ticket 3.5 — Tests d'intégration : transfers / refunds / DLQ / reconcile.
 *
 * Couverture obligatoire (correction CTO 2026-05-12) :
 *   ✓ transfer après CAPTURED (stripe.transfers.create + DB SENT)
 *   ✓ no double payout (idempotency Stripe + unique Transfer.paymentId)
 *   ✓ transfer.reversed → Transfer REVERSED + Mission DISPUTE_OPEN
 *   ✓ refund admin only (RBAC 403 si CLIENT)
 *   ✓ full refund only (422 PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED)
 *   ✓ no double refund (409 PAYMENT_INVALID_STATE)
 *   ✓ refund blocked after Transfer SENT (409 PAYMENT_REFUND_BLOCKED_TRANSFER_SENT)
 *   ✓ DLQ replay admin only (RBAC 403 si CLIENT, 202 si ADMIN)
 *   ✓ reconciliation cron — Transfer PENDING > 2h détecté
 *   ✓ Stripe metadata no PII (uniquement UUIDs `mission_id` / `payment_id`)
 *
 * Stratégie : on stub `STRIPE_CLIENT_TOKEN` complet (paymentIntents / transfers /
 * refunds / events / webhooks). Aucun appel réseau Stripe. Tous les états sont
 * vérifiés directement en DB Prisma.
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import type Stripe from 'stripe'
import request from 'supertest'

import { getQueueToken } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { STRIPE_WEBHOOK_QUEUE } from '../../src/modules/payments/payments.constants'
import { OutboundTransferService } from '../../src/modules/payments/transfers/outbound-transfer.service'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'
import { PaymentDomainHandler } from '../../src/modules/payments/webhooks/payment-domain.handler'
import { TransferDomainHandler } from '../../src/modules/payments/webhooks/transfer-domain.handler'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

/** Stripe stub — capture chaque appel pour vérifications metadata + idempotence. */
interface StripeStub {
  paymentIntents: {
    create: jest.Mock
    retrieve: jest.Mock
  }
  transfers: {
    create: jest.Mock
    retrieve: jest.Mock
  }
  refunds: {
    create: jest.Mock
  }
  events: { retrieve: jest.Mock }
  webhooks: { constructEvent: jest.Mock }
  /** Compteurs / inspections de tests (rule architecte-api §tests). */
  __captured: {
    transferCreates: { args: unknown[]; idempotencyKey: string | undefined }[]
    refundCreates: { args: unknown[]; idempotencyKey: string | undefined }[]
  }
}

function buildStripeStub(): StripeStub {
  const captured: StripeStub['__captured'] = {
    transferCreates: [],
    refundCreates: [],
  }

  const transferState = new Map<string, Stripe.Transfer>()

  return {
    paymentIntents: {
      create: jest.fn(async () => ({
        id: `pi_t35_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        client_secret: 'pi_t35_secret',
        status: 'requires_payment_method',
        latest_charge: `ch_t35_${Math.random().toString(36).slice(2, 10)}`,
      })),
      retrieve: jest.fn(async (id: string) => ({
        id,
        client_secret: `${id}_secret`,
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
        // Comportement idempotent réaliste : Stripe renvoie le même objet sur
        // même `Idempotency-Key`. Côté serveur l'unique `Transfer.paymentId`
        // empêche déjà la double création — on duplique le garde-fou ici.
        if (key && transferState.has(key)) {
          return transferState.get(key) as Stripe.Transfer
        }
        const tr = {
          id: `tr_${Math.random().toString(36).slice(2, 10)}`,
          amount: args.amount,
          currency: args.currency,
          destination: args.destination,
          metadata: args.metadata ?? {},
          reversed: false,
          amount_reversed: 0,
          transfer_group: args.transfer_group ?? null,
        } as unknown as Stripe.Transfer
        if (key) transferState.set(key, tr)
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
    refunds: {
      create: jest.fn(async (args: Stripe.RefundCreateParams, opts?: { idempotencyKey?: string }) => {
        captured.refundCreates.push({ args, idempotencyKey: opts?.idempotencyKey })
        return {
          id: `re_${Math.random().toString(36).slice(2, 10)}`,
          amount: args.amount,
          status: 'pending',
          payment_intent: args.payment_intent,
          metadata: args.metadata ?? {},
        } as unknown as Stripe.Refund
      }),
    },
    events: { retrieve: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
    __captured: captured,
  }
}

async function buildApp(): Promise<{
  app: INestApplication
  stripe: StripeStub
  webhookQueue: Queue
}> {
  process.env['FF_PAYMENTS_ENABLED'] = 'true'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
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
  return { app, stripe, webhookQueue }
}

interface CapturedFixture {
  missionId: string
  paymentId: string
  intentId: string
  prestataireId: string
  clientId: string
}

/**
 * Helper : crée un Payment en `CAPTURED`, Mission en `COMPLETED`, avec un
 * prestataire `READY` (capabilities Stripe Connect satisfaites).
 *
 * Évite tout le chemin HTTP `/complete` (hors-scope de ce test focalisé
 * webhooks 3.5).
 */
async function makeCapturedFixture(
  app: INestApplication,
  stripe: StripeStub,
  opts: { stripeAccountId?: string } = {},
): Promise<CapturedFixture> {
  const prisma = app.get(PrismaService)

  const client = await createTestUser(prisma, {
    role: 'CLIENT',
    base: {
      city: 'Paris',
      zipCode: '75011',
      street: '12 rue Oberkampf',
      lat: 48.8638,
      lng: 2.3777,
    },
  })

  const prestataire = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: {
      city: 'Paris',
      zipCode: '75010',
      street: '5 rue Bichat',
      lat: 48.871,
      lng: 2.366,
    },
  })
  await prisma.user.update({
    where: { id: prestataire.id },
    data: {
      providerPayoutStatus: 'READY',
      stripeAccountId: opts.stripeAccountId ?? `acct_test_${prestataire.id.slice(0, 8)}`,
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
      address: {
        street: '12 rue Oberkampf',
        city: 'Paris',
        zipCode: '75011',
        country: 'FR',
      },
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
    .set('idempotency-key', `t35-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    .send({ missionId: draft.body.id })
  if (intent.status !== 201) {
    throw new Error(`intent failed: ${intent.status} ${JSON.stringify(intent.body)}`)
  }

  // Brut DB : skip HTTP /complete (qui exige photos) — on fait passer le
  // payment directement en AUTHORIZED puis CLIENT_VALIDATION_PENDING, et on
  // déclenche le webhook `payment_intent.succeeded` via le handler domain.
  await prisma.payment.update({
    where: { id: intent.body.paymentId },
    data: { status: 'AUTHORIZED' },
  })
  await prisma.mission.update({
    where: { id: draft.body.id },
    data: {
      status: 'CLIENT_VALIDATION_PENDING',
      prestataireId: prestataire.id,
    },
  })

  // Capture via webhook payment_intent.succeeded → trigger outbound transfer.
  const handler = app.get(PaymentDomainHandler)
  await handler.handle(makeEvent('payment_intent.succeeded', {
    id: intent.body.stripePaymentIntentId,
    amount: 15_000,
    amount_received: 15_000,
    status: 'succeeded',
    latest_charge: `ch_t35_${draft.body.id.slice(0, 8)}`,
  }))

  return {
    missionId: draft.body.id,
    paymentId: intent.body.paymentId,
    intentId: intent.body.stripePaymentIntentId,
    prestataireId: prestataire.id,
    clientId: client.id,
  }
}

function makeEvent(type: string, intent: Partial<Stripe.PaymentIntent>): Stripe.Event {
  return {
    id: `evt_t35_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: intent as Stripe.PaymentIntent },
  } as Stripe.Event
}

function makeTransferEvent(
  type: 'transfer.created' | 'transfer.updated' | 'transfer.reversed',
  payload: Partial<Stripe.Transfer> | Partial<Stripe.TransferReversal>,
): Stripe.Event {
  return {
    id: `evt_tr_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: payload as Stripe.Transfer },
  } as Stripe.Event
}

describe('PRD-003 Ticket 3.5 — Transfers / Refunds / DLQ / Reconcile', () => {
  let app: INestApplication
  let stripe: StripeStub
  let webhookQueue: Queue
  let prisma: PrismaService

  beforeAll(async () => {
    const built = await buildApp()
    app = built.app
    stripe = built.stripe
    webhookQueue = built.webhookQueue
    prisma = app.get(PrismaService)
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
          await prisma.refund.deleteMany({
            where: { payment: { missionId: { in: missionIds } } },
          })
          await prisma.transfer.deleteMany({
            where: { payment: { missionId: { in: missionIds } } },
          })
          await prisma.autoReleaseJob.deleteMany({
            where: { missionId: { in: missionIds } },
          })
          await prisma.payment.deleteMany({ where: { missionId: { in: missionIds } } })
        }
      }
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Transfer outbound — happy path + idempotence (no double payout) + metadata
  // ---------------------------------------------------------------------------

  describe('Transfer outbound après CAPTURED', () => {
    it('crée un Transfer SENT avec metadata UUIDs uniquement (no PII)', async () => {
      const fx = await makeCapturedFixture(app, stripe)

      const transfer = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(transfer).not.toBeNull()
      expect(transfer!.status).toBe('SENT')
      expect(transfer!.stripeTransferId).toBeTruthy()
      expect(transfer!.idempotencyKey).toBe(`transfer-mission-${fx.missionId}`)

      const call = stripe.__captured.transferCreates.at(-1)
      expect(call).toBeDefined()
      expect(call!.idempotencyKey).toBe(`transfer-mission-${fx.missionId}`)

      // Metadata Stripe → UUIDs only (rule securite + stripe + PRD-003 §4.3)
      const args = call!.args as Stripe.TransferCreateParams
      expect(args.metadata).toEqual({
        mission_id: fx.missionId,
        payment_id: fx.paymentId,
      })
      // Pas d'email/adresse/nom dans aucun champ
      const serialized = JSON.stringify(args)
      expect(serialized).not.toMatch(/@cc-test\.fr/u)
      expect(serialized).not.toMatch(/Oberkampf/u)
    })

    it('no double payout : replay payment_intent.succeeded → un seul transfer Stripe', async () => {
      const fx = await makeCapturedFixture(app, stripe)

      const callsBefore = stripe.__captured.transferCreates.length
      const handler = app.get(PaymentDomainHandler)
      // Replay : même PaymentIntent succeeded (cas retry Stripe)
      await handler.handle(
        makeEvent('payment_intent.succeeded', {
          id: fx.intentId,
          amount: 15_000,
          amount_received: 15_000,
          status: 'succeeded',
        }),
      )

      const callsAfter = stripe.__captured.transferCreates.length
      // Au pire un appel supplémentaire à transfers.create AVEC la même
      // idempotency key → Stripe renvoie le même objet. La DB doit, elle,
      // rester strictement à 1 ligne `Transfer.paymentId`.
      const transfers = await prisma.transfer.findMany({ where: { paymentId: fx.paymentId } })
      expect(transfers.length).toBe(1)
      expect(transfers[0]!.status).toBe('SENT')

      if (callsAfter > callsBefore) {
        // Si un second appel a été émis, il DOIT porter la même idempotencyKey
        // (anti double-payout réseau côté Stripe).
        const last = stripe.__captured.transferCreates.at(-1)
        expect(last!.idempotencyKey).toBe(`transfer-mission-${fx.missionId}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Transfer reversed — Mission DISPUTE_OPEN
  // ---------------------------------------------------------------------------

  describe('Webhook transfer.reversed', () => {
    it('marque le Transfer REVERSED + Mission COMPLETED → DISPUTE_OPEN', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      const stripeTransferId = tr!.stripeTransferId as string

      // Force le stub Stripe à renvoyer un transfer marqué `reversed`
      stripe.transfers.retrieve.mockImplementationOnce(async (id: string) => ({
        id,
        amount: 12_000,
        currency: 'eur',
        reversed: true,
        amount_reversed: 12_000,
        metadata: {},
      } as unknown as Stripe.Transfer))

      const transferHandler = app.get(TransferDomainHandler)
      await transferHandler.handle(
        makeTransferEvent('transfer.reversed', {
          id: `trr_${Math.random().toString(36).slice(2, 10)}`,
          transfer: stripeTransferId,
          amount: 12_000,
        }),
      )

      const reversed = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(reversed!.status).toBe('REVERSED')

      const mission = await prisma.mission.findUnique({ where: { id: fx.missionId } })
      expect(mission!.status).toBe('DISPUTE_OPEN')

      const events = await prisma.missionEvent.findMany({
        where: { missionId: fx.missionId, type: 'TRANSFER_REVERSED' },
      })
      expect(events.length).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Refund — admin only + full only + no double + blocked after SENT
  // ---------------------------------------------------------------------------

  describe('POST /admin/payments/:id/refund', () => {
    it('CLIENT → 403 (RBAC admin only)', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const clientToken = await forgeAccessToken(app, { id: fx.clientId, role: 'CLIENT' })
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${fx.paymentId}/refund`)
        .set('authorization', `Bearer ${clientToken}`)
        .send({})
      expect(res.status).toBe(403)
    })

    it('ADMIN → 409 PAYMENT_REFUND_BLOCKED_TRANSFER_SENT si Transfer SENT', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${fx.paymentId}/refund`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({})
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('PAYMENT_REFUND_BLOCKED_TRANSFER_SENT')
    })

    it('ADMIN + partial → 422 PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      // Force Transfer en FAILED pour débloquer le check `SENT`
      await prisma.transfer.update({
        where: { paymentId: fx.paymentId },
        data: { status: 'FAILED' },
      })

      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${fx.paymentId}/refund`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ amountCents: 5_000 })
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED')
    })

    it('ADMIN + full → 202, second appel → 409 no double refund', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      await prisma.transfer.update({
        where: { paymentId: fx.paymentId },
        data: { status: 'FAILED' },
      })

      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const first = await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${fx.paymentId}/refund`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({})
      expect(first.status).toBe(202)
      expect(first.body.accepted).toBe(true)
      expect(typeof first.body.refundId).toBe('string')

      // Metadata Stripe → UUIDs only
      const refundCall = stripe.__captured.refundCreates.at(-1)!
      const args = refundCall.args as Stripe.RefundCreateParams
      expect(args.metadata).toEqual({
        mission_id: fx.missionId,
        payment_id: fx.paymentId,
        refund_id: first.body.refundId,
      })
      const serialized = JSON.stringify(args)
      expect(serialized).not.toMatch(/@cc-test\.fr/u)

      // Second appel — un refund PENDING existe déjà → 409
      const second = await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${fx.paymentId}/refund`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({})
      expect(second.status).toBe(409)
      expect(second.body.error).toBe('PAYMENT_INVALID_STATE')
    })
  })

  // ---------------------------------------------------------------------------
  // DLQ replay — admin only
  // ---------------------------------------------------------------------------

  describe('POST /admin/webhooks/stripe-dead-letters/:id/replay', () => {
    it('CLIENT → 403 (RBAC admin only)', async () => {
      const client = await createTestUser(prisma, { role: 'CLIENT' })
      const token = await forgeAccessToken(app, { id: client.id, role: 'CLIENT' })

      // Seed un row DLQ minimal pour atteindre la route
      const evtId = `evt_dlq_${Date.now()}`
      await prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: evtId,
          type: 'payment_intent.succeeded',
          payloadHash: 'a'.repeat(64),
          livemode: false,
          processingStatus: 'FAILED',
        },
      })
      const dlq = await prisma.webhookDeadLetter.create({
        data: {
          source: 'STRIPE',
          externalEventId: evtId,
          payloadHash: 'a'.repeat(64),
          errorMessage: 'forced for test',
          attempts: 5,
          lastAttemptAt: new Date(),
        },
      })

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/webhooks/stripe-dead-letters/${dlq.id}/replay`)
        .set('authorization', `Bearer ${token}`)
        .send({})
      expect(res.status).toBe(403)
    })

    it('ADMIN → 202 + re-enqueue BullMQ avec jobId déterministe', async () => {
      const evtId = `evt_dlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      await prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: evtId,
          type: 'payment_intent.succeeded',
          payloadHash: 'b'.repeat(64),
          livemode: false,
          processingStatus: 'FAILED',
        },
      })
      const dlq = await prisma.webhookDeadLetter.create({
        data: {
          source: 'STRIPE',
          externalEventId: evtId,
          payloadHash: 'b'.repeat(64),
          errorMessage: 'forced for test',
          attempts: 5,
          lastAttemptAt: new Date(),
        },
      })

      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      // Spy sur l'instance réelle de la queue Bull (vs override provider, qui
      // casse le BullExplorer / Worker — cf. doc bull.explorer.js). On ne
      // s'appuie PAS sur l'état DB post-replay : le worker BullMQ consume
      // aussitôt le job ré-enqueue et le marque FAILED (timing CI Linux).
      // Le contrat métier est : `replayStripeDeadLetter` a bien posé un job
      // déterministe sur la queue (jobId `stripe-webhook-replay-…`).
      const addSpy = jest.spyOn(webhookQueue, 'add')
      addSpy.mockClear()

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/webhooks/stripe-dead-letters/${dlq.id}/replay`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({})
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ accepted: true })

      expect(addSpy).toHaveBeenCalledTimes(1)
      const [jobName, payload, opts] = addSpy.mock.calls[0] as [
        string,
        { stripeEventId: string; type: string; livemode: boolean; payloadHash: string },
        { jobId: string },
      ]
      expect(jobName).toBe('process')
      expect(payload.stripeEventId).toBe(evtId)
      expect(payload.type).toBe('payment_intent.succeeded')
      expect(payload.livemode).toBe(false)
      expect(opts.jobId).toMatch(/^stripe-webhook-replay-/u)

      addSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // Reconcile cron — Transfer PENDING > 2h détecté
  // ---------------------------------------------------------------------------

  describe('reconcileStaleTransfersBatch', () => {
    it('détecte un Transfer PENDING avec updatedAt > 2h et appelle stripe.transfers.retrieve', async () => {
      const fx = await makeCapturedFixture(app, stripe)
      const tr = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })

      // Simule un transfer bloqué en PENDING depuis > 2h
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1_000)
      await prisma.transfer.update({
        where: { id: tr!.id },
        data: { status: 'PENDING', updatedAt: threeHoursAgo },
      })

      stripe.transfers.retrieve.mockClear()
      const outbound = app.get(OutboundTransferService)
      await outbound.reconcileStaleTransfersBatch()

      expect(stripe.transfers.retrieve).toHaveBeenCalledWith(tr!.stripeTransferId)
    })
  })
})
