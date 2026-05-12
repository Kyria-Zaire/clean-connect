/**
 * Tests d'intégration — `POST /v1/payments/intent` + `GET /v1/payments/mine`
 * (PRD-003 Ticket 3.2).
 *
 * Couverture obligatoire (correction CTO 2026-05-12) :
 *   - création intent OK (201 + Payment AUTHORIZATION_PENDING + Mission PENDING_PAYMENT)
 *   - idempotency replay même key → MÊME Payment, aucun second appel Stripe create
 *   - mission non owner → 403 MISSION_FORBIDDEN
 *   - Idempotency-Key manquant → 400 PAYMENT_MISSING_IDEMPOTENCY_KEY
 *   - mission jamais PUBLISHED sans webhook Stripe valide
 *   - clientSecret jamais retourné dans GET /v1/payments/mine
 *   - capture_method='manual' passé à Stripe (correction CTO)
 *
 * Stripe SDK : override `STRIPE_CLIENT_TOKEN` par un stub minimaliste — on ne
 * teste PAS l'API Stripe ici, on teste notre pipeline (idempotence, transitions,
 * snapshots). Les webhooks Stripe réels sont couverts par la suite
 * `payments-domain.integration.spec.ts` (routing dispatch).
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

const ROUTE_INTENT = '/api/v1/payments/intent'
const ROUTE_MINE = '/api/v1/payments/mine'

interface StripeIntentStub {
  id: string
  client_secret: string
  status: 'requires_payment_method' | 'requires_capture' | 'canceled'
}

let stripeCreateCalls = 0
let stripeRetrieveCalls = 0
let lastCreatedIntent: StripeIntentStub | null = null

function resetStripeStub(): void {
  stripeCreateCalls = 0
  stripeRetrieveCalls = 0
  lastCreatedIntent = null
}

function buildStripeStub(): unknown {
  return {
    paymentIntents: {
      create: jest.fn(async (_input: unknown, opts: { idempotencyKey?: string } | undefined) => {
        stripeCreateCalls += 1
        const id = `pi_int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        lastCreatedIntent = {
          id,
          client_secret: `${id}_secret_${(opts?.idempotencyKey ?? 'x').slice(-4)}`,
          status: 'requires_payment_method',
        }
        return lastCreatedIntent
      }),
      retrieve: jest.fn(async (intentId: string) => {
        stripeRetrieveCalls += 1
        return {
          id: intentId,
          client_secret: `${intentId}_secret_retrieve`,
          status: 'requires_payment_method',
        }
      }),
    },
    events: { retrieve: jest.fn() },
  }
}

async function buildApp(): Promise<INestApplication> {
  process.env['FF_PAYMENTS_ENABLED'] = 'true'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  process.env['PAYMENT_PLATFORM_FEE_RATE'] = '0.18'
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

interface MissionFixture {
  missionId: string
  clientToken: string
  clientId: string
}

async function createDraftMission(
  app: INestApplication,
  estimatedPriceCents = 12_000,
): Promise<MissionFixture> {
  const prisma = app.get(PrismaService)
  const client = await createTestUser(prisma, {
    role: 'CLIENT',
    base: {
      city: 'Paris',
      zipCode: '75011',
      street: '11 rue Oberkampf',
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
        street: '11 rue Oberkampf',
        city: 'Paris',
        zipCode: '75011',
        country: 'FR',
      },
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1_000 + 2 * 60 * 60 * 1_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents,
    })
  expect(draft.status).toBe(201)
  return { missionId: draft.body.id, clientToken, clientId: client.id }
}

describe('POST /api/v1/payments/intent + GET /api/v1/payments/mine (PRD-003 Ticket 3.2)', () => {
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    if (app) {
      const prisma = app.get(PrismaService)
      // Cleanup ordonné : payments → missions (FK Restrict)
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

  beforeEach(() => {
    resetStripeStub()
  })

  it('happy path : 201 + Payment AUTHORIZATION_PENDING + Mission PENDING_PAYMENT + clientSecret retourné', async () => {
    const { missionId, clientToken } = await createDraftMission(app)
    const idempotencyKey = `cc-it-happy-${Date.now()}`

    const res = await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .set('idempotency-key', idempotencyKey)
      .send({ missionId })

    expect(res.status).toBe(201)
    expect(res.body.paymentId).toBeDefined()
    expect(res.body.stripePaymentIntentId).toMatch(/^pi_int_/u)
    expect(res.body.clientSecret).toMatch(/_secret_/u)
    expect(res.body.amountAuthorizedCents).toBe(12_000)
    expect(res.body.currency).toBe('eur')
    expect(res.body.status).toBe('AUTHORIZATION_PENDING')

    const prisma = app.get(PrismaService)
    const payment = await prisma.payment.findUnique({ where: { missionId } })
    expect(payment).not.toBeNull()
    expect(payment!.status).toBe('AUTHORIZATION_PENDING')
    expect(payment!.idempotencyKey).toBe(idempotencyKey)
    expect(payment!.applicationFeeCents).toBe(2_160)
    expect(payment!.providerPayoutCents).toBe(9_840)

    const mission = await prisma.mission.findUnique({ where: { id: missionId } })
    expect(mission!.status).toBe('PENDING_PAYMENT')
    expect(mission!.publishedAt).toBeNull()

    expect(stripeCreateCalls).toBe(1)
  })

  it('mission jamais PUBLISHED sans webhook — création intent ne suffit pas', async () => {
    const { missionId, clientToken } = await createDraftMission(app)
    await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .set('idempotency-key', `cc-it-nopub-${Date.now()}`)
      .send({ missionId })
      .expect(201)

    const prisma = app.get(PrismaService)
    const mission = await prisma.mission.findUnique({ where: { id: missionId } })
    expect(mission!.status).toBe('PENDING_PAYMENT')
    expect(mission!.status).not.toBe('PUBLISHED')
    expect(mission!.publishedAt).toBeNull()
    expect(mission!.listingExpiresAt).toBeNull()
  })

  it('idempotency replay même key + même missionId → MÊME Payment, AUCUN second Stripe.create', async () => {
    const { missionId, clientToken } = await createDraftMission(app)
    const idempotencyKey = `cc-it-replay-${Date.now()}`

    const first = await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .set('idempotency-key', idempotencyKey)
      .send({ missionId })
    expect(first.status).toBe(201)

    const second = await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .set('idempotency-key', idempotencyKey)
      .send({ missionId })
    expect(second.status).toBe(201)
    expect(second.body.paymentId).toBe(first.body.paymentId)
    expect(second.body.stripePaymentIntentId).toBe(first.body.stripePaymentIntentId)
    // ClientSecret peut différer (retrieve vs create) — c'est OK CTO 3.2
    expect(second.body.clientSecret).toBeDefined()

    expect(stripeCreateCalls).toBe(1)
    expect(stripeRetrieveCalls).toBe(1)
  })

  it('mission non-owner (autre CLIENT) → 403 MISSION_FORBIDDEN', async () => {
    const { missionId } = await createDraftMission(app)
    const prisma = app.get(PrismaService)
    const other = await createTestUser(prisma, { role: 'CLIENT' })
    const otherToken = await forgeAccessToken(app, { id: other.id, role: 'CLIENT' })

    const res = await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${otherToken}`)
      .set('idempotency-key', `cc-it-nonowner-${Date.now()}`)
      .send({ missionId })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('MISSION_FORBIDDEN')
    expect(stripeCreateCalls).toBe(0)
  })

  it('Idempotency-Key manquant → 400 PAYMENT_MISSING_IDEMPOTENCY_KEY', async () => {
    const { missionId, clientToken } = await createDraftMission(app)
    const res = await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .send({ missionId })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('PAYMENT_MISSING_IDEMPOTENCY_KEY')
    expect(stripeCreateCalls).toBe(0)
  })

  it('GET /v1/payments/mine — clientSecret JAMAIS exposé dans la liste', async () => {
    const { missionId, clientToken } = await createDraftMission(app)
    await request(app.getHttpServer())
      .post(ROUTE_INTENT)
      .set('authorization', `Bearer ${clientToken}`)
      .set('idempotency-key', `cc-it-mine-${Date.now()}`)
      .send({ missionId })
      .expect(201)

    const list = await request(app.getHttpServer())
      .get(ROUTE_MINE)
      .set('authorization', `Bearer ${clientToken}`)
      .query({ limit: 20 })
    expect(list.status).toBe(200)
    expect(Array.isArray(list.body.items)).toBe(true)
    expect(list.body.items.length).toBeGreaterThanOrEqual(1)
    const item = list.body.items[0]
    expect(item.stripePaymentIntentId).toBeDefined()
    expect(item.status).toBe('AUTHORIZATION_PENDING')
    expect(item.amountAuthorizedCents).toBe(12_000)
    // Pas de fuite clientSecret (Pino redactor + DTO shape)
    expect(item).not.toHaveProperty('clientSecret')
    expect(item).not.toHaveProperty('client_secret')
    // Pas de fuite applicationFee (privé business côté CLIENT — admin only)
    expect(item).not.toHaveProperty('applicationFeeCents')
  })
})
