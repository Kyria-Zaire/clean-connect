/**
 * Tests d'intégration — routing des events `payment_intent.*` via
 * `PaymentDomainHandler` (PRD-003 Ticket 3.2).
 *
 * Couverture obligatoire (correction CTO 2026-05-12) :
 *   - webhook autorisation (`amount_capturable_updated`) → Payment AUTHORIZED
 *     + Mission `PENDING_PAYMENT → PUBLISHED` (+ publishedAt/listingExpiresAt)
 *   - webhook payment_failed → Payment FAILED + Mission RESTE `PENDING_PAYMENT`
 *   - webhook canceled (requested_by_customer) → Payment CANCELLED + Mission
 *     `PENDING_PAYMENT → CANCELLED`
 *   - webhook canceled `cancellation_reason='automatic'` → failureCode
 *     `authorization_expired` (préparation Ticket 3.4)
 *   - replay : passer le même event 2x = no-op (idempotent)
 *
 * Stratégie : on crée un Payment réel en DB via `POST /v1/payments/intent`
 * (avec stub Stripe minimal), puis on appelle directement
 * `PaymentDomainHandler.handle()` avec un `Stripe.Event` construit en mémoire
 * (le routing HTTP/BullMQ est couvert par 3.1).
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
import { PaymentDomainHandler } from '../../src/modules/payments/webhooks/payment-domain.handler'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

function buildStripeStub(): unknown {
  return {
    paymentIntents: {
      create: jest.fn(async () => ({
        id: `pi_dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        client_secret: 'pi_dom_secret_xyz',
        status: 'requires_payment_method',
      })),
      retrieve: jest.fn(async (id: string) => ({
        id,
        client_secret: `${id}_secret_re`,
        status: 'requires_payment_method',
      })),
    },
    events: { retrieve: jest.fn() },
  }
}

async function buildApp(): Promise<INestApplication> {
  process.env['FF_PAYMENTS_ENABLED'] = 'true'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  __resetEnvCacheForTests()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STRIPE_CLIENT_TOKEN)
    .useValue(buildStripeStub())
    .compile()

  const app = moduleRef.createNestApplication({ rawBody: true })
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

interface PaymentFixture {
  missionId: string
  paymentId: string
  intentId: string
}

async function createIntentForMission(app: INestApplication): Promise<PaymentFixture> {
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
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1_000 + 2 * 60 * 60 * 1_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents: 15_000,
    })
  expect(draft.status).toBe(201)

  const intent = await request(app.getHttpServer())
    .post('/api/v1/payments/intent')
    .set('authorization', `Bearer ${clientToken}`)
    .set('idempotency-key', `cc-dom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    .send({ missionId: draft.body.id })
  expect(intent.status).toBe(201)
  return {
    missionId: draft.body.id,
    paymentId: intent.body.paymentId,
    intentId: intent.body.stripePaymentIntentId,
  }
}

function makeEvent(
  type: Stripe.Event['type'],
  intent: Partial<Stripe.PaymentIntent>,
): Stripe.Event {
  return {
    id: `evt_dom_${Math.random().toString(36).slice(2, 10)}`,
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

describe('PaymentDomainHandler (PRD-003 Ticket 3.2)', () => {
  let app: INestApplication
  let handler: PaymentDomainHandler

  beforeAll(async () => {
    app = await buildApp()
    handler = app.get(PaymentDomainHandler)
  })

  afterAll(async () => {
    if (app) {
      const prisma = app.get(PrismaService)
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
          await prisma.payment.deleteMany({ where: { missionId: { in: missionIds } } })
        }
      }
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  it('shouldHandle filtre les types non gérés en 3.2', () => {
    expect(handler.shouldHandle('payment_intent.amount_capturable_updated')).toBe(true)
    expect(handler.shouldHandle('payment_intent.payment_failed')).toBe(true)
    expect(handler.shouldHandle('payment_intent.canceled')).toBe(true)
    expect(handler.shouldHandle('payment_intent.created')).toBe(false)
    expect(handler.shouldHandle('charge.succeeded')).toBe(false)
    expect(handler.shouldHandle('transfer.created')).toBe(false)
  })

  it('amount_capturable_updated → Payment AUTHORIZED + Mission PUBLISHED + publishedAt + matching tente', async () => {
    const fixture = await createIntentForMission(app)
    const event = makeEvent('payment_intent.amount_capturable_updated', {
      id: fixture.intentId,
      amount: 15_000,
    })

    await handler.handle(event)

    const prisma = app.get(PrismaService)
    const payment = await prisma.payment.findUnique({ where: { id: fixture.paymentId } })
    expect(payment!.status).toBe('AUTHORIZED')

    const mission = await prisma.mission.findUnique({ where: { id: fixture.missionId } })
    expect(mission!.status).toBe('PUBLISHED')
    expect(mission!.publishedAt).not.toBeNull()
    expect(mission!.listingExpiresAt).not.toBeNull()

    // Audit : 2 events posés (PAYMENT_AUTHORIZED + PUBLISHED).
    const events = await prisma.missionEvent.findMany({
      where: { missionId: fixture.missionId },
      orderBy: { createdAt: 'asc' },
    })
    const types = events.map((e) => e.type)
    expect(types).toContain('PAYMENT_AUTHORIZED')
    expect(types).toContain('PUBLISHED')
  })

  it('replay du même event amount_capturable_updated → no-op (idempotent)', async () => {
    const fixture = await createIntentForMission(app)
    const event = makeEvent('payment_intent.amount_capturable_updated', {
      id: fixture.intentId,
      amount: 15_000,
    })

    await handler.handle(event)
    // Replay
    await handler.handle(event)

    const prisma = app.get(PrismaService)
    const events = await prisma.missionEvent.findMany({
      where: { missionId: fixture.missionId, type: 'PAYMENT_AUTHORIZED' },
    })
    expect(events.length).toBe(1)
  })

  it('payment_failed → Payment FAILED, Mission RESTE en PENDING_PAYMENT (retry client possible)', async () => {
    const fixture = await createIntentForMission(app)
    const event = makeEvent('payment_intent.payment_failed', {
      id: fixture.intentId,
      last_payment_error: {
        code: 'card_declined',
        message: 'Your card was declined.',
        type: 'card_error',
      } as Stripe.PaymentIntent.LastPaymentError,
    })

    await handler.handle(event)

    const prisma = app.get(PrismaService)
    const payment = await prisma.payment.findUnique({ where: { id: fixture.paymentId } })
    expect(payment!.status).toBe('FAILED')
    expect(payment!.failureCode).toBe('card_declined')

    const mission = await prisma.mission.findUnique({ where: { id: fixture.missionId } })
    expect(mission!.status).toBe('PENDING_PAYMENT')

    const events = await prisma.missionEvent.findMany({
      where: { missionId: fixture.missionId, type: 'PAYMENT_FAILED' },
    })
    expect(events.length).toBe(1)
  })

  it('canceled (requested_by_customer) → Payment CANCELLED + Mission CANCELLED', async () => {
    const fixture = await createIntentForMission(app)
    const event = makeEvent('payment_intent.canceled', {
      id: fixture.intentId,
      cancellation_reason: 'requested_by_customer',
    })

    await handler.handle(event)

    const prisma = app.get(PrismaService)
    const payment = await prisma.payment.findUnique({ where: { id: fixture.paymentId } })
    expect(payment!.status).toBe('CANCELLED')
    expect(payment!.failureCode).toBe('requested_by_customer')

    const mission = await prisma.mission.findUnique({ where: { id: fixture.missionId } })
    expect(mission!.status).toBe('CANCELLED')
  })

  it('canceled (automatic) → failureCode authorization_expired (préparation Ticket 3.4)', async () => {
    const fixture = await createIntentForMission(app)
    const event = makeEvent('payment_intent.canceled', {
      id: fixture.intentId,
      cancellation_reason: 'automatic',
    })

    await handler.handle(event)

    const prisma = app.get(PrismaService)
    const payment = await prisma.payment.findUnique({ where: { id: fixture.paymentId } })
    expect(payment!.status).toBe('CANCELLED')
    expect(payment!.failureCode).toBe('authorization_expired')

    const events = await prisma.missionEvent.findMany({
      where: { missionId: fixture.missionId, type: 'PAYMENT_CANCELLED' },
    })
    expect(events.length).toBe(1)
    const payload = events[0]!.payload as { isAuthorizationExpired?: boolean }
    expect(payload.isAuthorizationExpired).toBe(true)
  })
})
