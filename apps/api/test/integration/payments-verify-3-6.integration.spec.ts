/**
 * PRD-003 Ticket 3.6 — Tests d'intégration Verify final.
 *
 * Renforcement des scénarios CTO V1-V11 / A-L qui restaient sous-couverts après 3.5.
 * Ces tests vérifient un contrat MÉTIER, pas de nouvelle feature (Verify, pas Build).
 *
 * Couverture ajoutée :
 *   - B (idempotence domain handler) : 5 appels successifs de `handler.handle`
 *     sur le même event `payment_intent.succeeded` → 1 mutation Payment +
 *     1 audit PAYMENT_CAPTURED + 1 audit MISSION_COMPLETED + 1 Transfer SENT.
 *   - V7 : prestataire `providerPayoutStatus` repassé `PAYOUTS_DISABLED` entre
 *     accept et capture → capture OK côté Payment, outbound transfer skip propre
 *     (pas d'appel `stripe.transfers.create`, pas de ligne `Transfer` créée).
 *   - V11 (compl.) : payment passé en `REFUNDED` (refund admin émis post-capture),
 *     l'appel `OutboundTransferService.ensureOutboundTransferAfterCapture` ne
 *     re-trigger PAS de transfer Stripe (payment.status !== CAPTURED).
 *
 * Notes :
 *   - V1 (replay 5× au niveau ingestion HTTP) est couvert par
 *     `payments-webhook.integration.spec.ts:187` (replay même `stripe_event_id`
 *     → 202 idempotent). On renforce ici l'idempotence à la couche DOMAIN
 *     (PaymentDomainHandler), qui est ré-exécutée par BullMQ en cas de retry.
 *   - V9 (spoofed webhook signature aléatoire → 400) est couvert par
 *     `payments-webhook.integration.spec.ts:152` ("HMAC invalide → 400").
 *
 * Stub Stripe : factorisé sur celui de `payments-ticket-3-5` (paymentIntents /
 * transfers / refunds / events).
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import type Stripe from 'stripe'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'
import { OutboundTransferService } from '../../src/modules/payments/transfers/outbound-transfer.service'
import { PaymentDomainHandler } from '../../src/modules/payments/webhooks/payment-domain.handler'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

interface StripeStub {
  paymentIntents: { create: jest.Mock; retrieve: jest.Mock }
  transfers: { create: jest.Mock; retrieve: jest.Mock }
  refunds: { create: jest.Mock }
  events: { retrieve: jest.Mock }
  webhooks: { constructEvent: jest.Mock }
  __captured: {
    transferCreates: { args: Stripe.TransferCreateParams; idempotencyKey: string | undefined }[]
  }
}

function buildStripeStub(): StripeStub {
  const captured: StripeStub['__captured'] = { transferCreates: [] }
  const transferState = new Map<string, Stripe.Transfer>()

  return {
    paymentIntents: {
      create: jest.fn(async () => ({
        id: `pi_v36_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        client_secret: 'pi_v36_secret',
        status: 'requires_payment_method',
        latest_charge: `ch_v36_${Math.random().toString(36).slice(2, 10)}`,
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
        if (key && transferState.has(key)) return transferState.get(key) as Stripe.Transfer
        const tr = {
          id: `tr_${Math.random().toString(36).slice(2, 10)}`,
          amount: args.amount,
          currency: args.currency,
          destination: args.destination,
          metadata: args.metadata ?? {},
          reversed: false,
          amount_reversed: 0,
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
      } as unknown as Stripe.Transfer)),
    },
    refunds: {
      create: jest.fn(async () => ({
        id: `re_${Math.random().toString(36).slice(2, 10)}`,
        status: 'pending',
      } as unknown as Stripe.Refund)),
    },
    events: { retrieve: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
    __captured: captured,
  }
}

async function buildApp(): Promise<{ app: INestApplication; stripe: StripeStub }> {
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
  return { app, stripe }
}

interface AuthorizedFixture {
  missionId: string
  paymentId: string
  intentId: string
  prestataireId: string
  clientId: string
}

/**
 * Helper : crée un client + prestataire READY + mission DRAFT + intent +
 * marque la mission `CLIENT_VALIDATION_PENDING`. Ne fait PAS la capture.
 */
async function makeReadyForCapture(app: INestApplication): Promise<AuthorizedFixture> {
  const prisma = app.get(PrismaService)
  const client = await createTestUser(prisma, {
    role: 'CLIENT',
    base: { city: 'Paris', zipCode: '75011', street: '12 rue Oberkampf', lat: 48.8638, lng: 2.3777 },
  })
  const prestataire = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: { city: 'Paris', zipCode: '75010', street: '5 rue Bichat', lat: 48.871, lng: 2.366 },
  })
  await prisma.user.update({
    where: { id: prestataire.id },
    data: {
      providerPayoutStatus: 'READY',
      stripeAccountId: `acct_v36_${prestataire.id.slice(0, 8)}`,
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
      address: { street: '12 rue Oberkampf', city: 'Paris', zipCode: '75011', country: 'FR' },
      startAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents: 15_000,
    })
  expect(draft.status).toBe(201)

  const intent = await request(app.getHttpServer())
    .post('/api/v1/payments/intent')
    .set('authorization', `Bearer ${clientToken}`)
    .set('idempotency-key', `v36-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    .send({ missionId: draft.body.id })
  expect(intent.status).toBe(201)

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

function makeSucceededEvent(intentId: string): Stripe.Event {
  return {
    id: `evt_v36_${Math.random().toString(36).slice(2, 10)}`,
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

describe('PRD-003 Ticket 3.6 — Verify final (audits CTO renforcés)', () => {
  let app: INestApplication
  let stripe: StripeStub
  let prisma: PrismaService

  beforeAll(async () => {
    const built = await buildApp()
    app = built.app
    stripe = built.stripe
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
  // B — Idempotence DOMAIN handler après 5 replays (retries BullMQ possibles)
  // ---------------------------------------------------------------------------

  describe('B — Idempotence PaymentDomainHandler (5 replays)', () => {
    it('5 appels handler.handle(succeeded) : 1 Payment CAPTURED, 1 audit, 1 Transfer SENT', async () => {
      const fx = await makeReadyForCapture(app)
      const handler = app.get(PaymentDomainHandler)
      const event = makeSucceededEvent(fx.intentId)

      for (let i = 0; i < 5; i += 1) {
        await handler.handle(event)
      }

      const payment = await prisma.payment.findUnique({ where: { id: fx.paymentId } })
      expect(payment!.status).toBe('CAPTURED')
      expect(payment!.amountCapturedCents).toBe(15_000)

      const audits = await prisma.missionEvent.findMany({
        where: { missionId: fx.missionId, type: 'PAYMENT_CAPTURED' },
      })
      expect(audits.length).toBe(1)

      const completedAudits = await prisma.missionEvent.findMany({
        where: { missionId: fx.missionId, type: 'MISSION_COMPLETED' },
      })
      expect(completedAudits.length).toBe(1)

      // Unique Transfer DB (no double payout en replay)
      const transfers = await prisma.transfer.findMany({ where: { paymentId: fx.paymentId } })
      expect(transfers.length).toBe(1)
      expect(transfers[0]!.status).toBe('SENT')
    })
  })

  // ---------------------------------------------------------------------------
  // V7 — providerPayoutStatus repassé PAYOUTS_DISABLED avant capture
  //      → outbound transfer skip + AUCUN appel stripe.transfers.create
  // ---------------------------------------------------------------------------

  describe('V7 — Payout disabled bloque le transfer post-capture', () => {
    it('prestataire stripePayoutsEnabled=false → capture OK, transfer skip', async () => {
      const fx = await makeReadyForCapture(app)
      // Régression capacités Stripe Connect (audit Verify : changement
      // intervenu entre accept et capture).
      await prisma.user.update({
        where: { id: fx.prestataireId },
        data: { stripePayoutsEnabled: false, providerPayoutStatus: 'PAYOUTS_DISABLED' },
      })

      const callsBefore = stripe.__captured.transferCreates.length
      const handler = app.get(PaymentDomainHandler)
      await handler.handle(makeSucceededEvent(fx.intentId))

      // Capture côté Payment ET Mission est faite (Stripe = source de vérité fonds)
      const payment = await prisma.payment.findUnique({ where: { id: fx.paymentId } })
      expect(payment!.status).toBe('CAPTURED')

      // En revanche, AUCUN stripe.transfers.create appelé (payout_not_ready)
      const callsAfter = stripe.__captured.transferCreates.length
      expect(callsAfter).toBe(callsBefore)

      // Pas de Transfer DB (le service garde la main : ne pose pas de ligne PENDING)
      const transfer = await prisma.transfer.findUnique({ where: { paymentId: fx.paymentId } })
      expect(transfer).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // V11 (compl.) — Refund émis + replay succeeded → no outbound transfer
  // ---------------------------------------------------------------------------

  describe('V11 — Refund vs replay capture', () => {
    it('après refund admin (Payment REFUNDED), replay succeeded ne triggere pas transfer', async () => {
      const fx = await makeReadyForCapture(app)
      const handler = app.get(PaymentDomainHandler)

      // 1. Capture initiale → Payment CAPTURED + Transfer SENT
      await handler.handle(makeSucceededEvent(fx.intentId))
      let payment = await prisma.payment.findUnique({ where: { id: fx.paymentId } })
      expect(payment!.status).toBe('CAPTURED')

      // 2. Force le payment en REFUNDED + Transfer FAILED (état possible post-refund admin)
      await prisma.transfer.update({
        where: { paymentId: fx.paymentId },
        data: { status: 'FAILED' },
      })
      await prisma.payment.update({
        where: { id: fx.paymentId },
        data: { status: 'REFUNDED' },
      })

      // 3. Replay payment_intent.succeeded — OutboundTransferService doit
      //    voir `payment.status !== 'CAPTURED'` et SKIP sans muter.
      const outbound = app.get(OutboundTransferService)
      const callsBefore = stripe.__captured.transferCreates.length
      await outbound.ensureOutboundTransferAfterCapture(fx.paymentId, 'PAYMENT_CAPTURE_WEBHOOK')

      const callsAfter = stripe.__captured.transferCreates.length
      expect(callsAfter).toBe(callsBefore)

      payment = await prisma.payment.findUnique({ where: { id: fx.paymentId } })
      expect(payment!.status).toBe('REFUNDED')
    })
  })

})
