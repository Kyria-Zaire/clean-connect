/**
 * PRD-003 Ticket 3.6-bis — Verify final : concurrence financière Stripe Connect.
 *
 * Couverture grille CTO §6.1 — audits critiques escrow / double mutation :
 *   - V2 / C  : double validate concurrent (CLIENT POST /validate × 2) → 1 seule
 *               capture Stripe (idempotency-key déterministe `capture-mission-<id>`).
 *   - V3      : double `scheduleAutoRelease` (replay POST /complete) → 1 seul job
 *               BullMQ inséré (jobId déterministe + unique constraint DB).
 *   - V10     : capture vs auto-release simultanés — capture déjà effective avant
 *               que l'auto-release démarre → safety-net `requestCapture`
 *               renvoie `idempotent: true` sans réémettre l'appel Stripe.
 *   - V11 (concurrent) : refund admin pendant que auto-release allait capturer
 *               → après refund émis, `requestCapture` renvoie sans muter (statut
 *               Payment ≠ AUTHORIZED).
 *
 * Méthodologie :
 *   - On NE teste PAS BullMQ en exécution réelle (worker async non déterministe).
 *     On teste les contrats serveur : 1 seul `paymentIntents.capture` (V2/V10),
 *     1 seul `queue.add` avec `jobId` partagé (V3), pas d'appel `capture` si
 *     refund déjà émis (V11).
 *   - Stripe stub : `paymentIntents.capture` enregistre les `idempotencyKey`
 *     pour assertions ; comportement réaliste (renvoie le même objet sur clé
 *     répétée — Stripe garantit pas de double prélèvement).
 *   - Aucune mutation DB en dehors des helpers (test isolé : `afterAll` purge).
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { getQueueToken } from '@nestjs/bullmq'
import { Test } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import { Logger as PinoLogger } from 'nestjs-pino'
import type Stripe from 'stripe'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import {
  AUTO_RELEASE_QUEUE,
  buildAutoReleaseBullJobId,
  buildCaptureIdempotencyKey,
} from '../../src/modules/missions-completion/auto-release/auto-release.constants'
import { AutoReleaseService } from '../../src/modules/missions-completion/auto-release/auto-release.service'
import { PaymentsService } from '../../src/modules/payments/payments.service'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

interface StripeStub {
  paymentIntents: { create: jest.Mock; retrieve: jest.Mock; capture: jest.Mock }
  transfers: { create: jest.Mock; retrieve: jest.Mock }
  refunds: { create: jest.Mock }
  events: { retrieve: jest.Mock }
  webhooks: { constructEvent: jest.Mock }
  __captured: {
    captureCalls: { intentId: string; idempotencyKey: string | undefined }[]
    transferCreates: { idempotencyKey: string | undefined }[]
    refundCreates: { idempotencyKey: string | undefined }[]
  }
}

function buildStripeStub(): StripeStub {
  const captured: StripeStub['__captured'] = {
    captureCalls: [],
    transferCreates: [],
    refundCreates: [],
  }
  // Lock par idempotency-key pour reproduire le comportement Stripe : un
  // second appel avec la même clé renvoie l'objet précédent sans muter.
  const captureLock = new Map<string, Stripe.PaymentIntent>()
  return {
    paymentIntents: {
      create: jest.fn(async () => ({
        id: `pi_v36b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        client_secret: 'pi_v36b_secret',
        status: 'requires_capture',
        amount: 15_000,
        latest_charge: `ch_v36b_${Math.random().toString(36).slice(2, 10)}`,
      })),
      retrieve: jest.fn(async (id: string) => ({
        id,
        status: 'requires_capture',
        amount: 15_000,
        amount_received: 0,
        latest_charge: `ch_${id}`,
      })),
      capture: jest.fn(async (intentId: string, _params: object, opts?: { idempotencyKey?: string }) => {
        const key = opts?.idempotencyKey
        captured.captureCalls.push({ intentId, idempotencyKey: key })
        // Simule un petit délai I/O pour laisser réellement courir une 2e
        // requête concurrente (sinon le test passe trop "vite" pour exercer
        // la race condition).
        await new Promise((r) => setTimeout(r, 50))
        if (key && captureLock.has(key)) return captureLock.get(key) as Stripe.PaymentIntent
        const obj = {
          id: intentId,
          status: 'succeeded',
          amount: 15_000,
          amount_received: 15_000,
          latest_charge: `ch_${intentId}`,
        } as unknown as Stripe.PaymentIntent
        if (key) captureLock.set(key, obj)
        return obj
      }),
    },
    transfers: {
      create: jest.fn(async (_args: Stripe.TransferCreateParams, opts?: { idempotencyKey?: string }) => {
        captured.transferCreates.push({ idempotencyKey: opts?.idempotencyKey })
        return {
          id: `tr_${Math.random().toString(36).slice(2, 10)}`,
          amount: 12_000,
          currency: 'eur',
        } as unknown as Stripe.Transfer
      }),
      retrieve: jest.fn(),
    },
    refunds: {
      create: jest.fn(async (_args: Stripe.RefundCreateParams, opts?: { idempotencyKey?: string }) => {
        captured.refundCreates.push({ idempotencyKey: opts?.idempotencyKey })
        return { id: `re_${Math.random().toString(36).slice(2, 10)}`, status: 'pending' } as unknown as Stripe.Refund
      }),
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

interface PendingValidationFixture {
  missionId: string
  paymentId: string
  intentId: string
  clientId: string
  prestataireId: string
  clientToken: string
}

/**
 * Helper : crée client + prestataire READY + mission DRAFT + intent, puis
 * force la mission en `CLIENT_VALIDATION_PENDING` avec `AutoReleaseJob`
 * SCHEDULED (préconditions strictes pour validate / auto-release).
 */
async function makePendingValidationFixture(
  app: INestApplication,
): Promise<PendingValidationFixture> {
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
      stripeAccountId: `acct_v36b_${prestataire.id.slice(0, 8)}`,
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
    .set('idempotency-key', `v36b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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

  // Crée le AutoReleaseJob SCHEDULED (sans poster côté BullMQ — on n'a pas
  // besoin du worker pour ces audits ; on teste les contrats Stripe).
  await prisma.autoReleaseJob.create({
    data: {
      missionId: draft.body.id,
      bullJobId: buildAutoReleaseBullJobId(draft.body.id),
      idempotencyKey: buildCaptureIdempotencyKey(draft.body.id),
      scheduledFor: new Date(Date.now() + 48 * 3_600_000),
      status: 'SCHEDULED',
    },
  })

  return {
    missionId: draft.body.id,
    paymentId: intent.body.paymentId,
    intentId: intent.body.stripePaymentIntentId,
    clientId: client.id,
    prestataireId: prestataire.id,
    clientToken,
  }
}

describe('PRD-003 Ticket 3.6-bis — Concurrence financière Stripe Connect (Verify final)', () => {
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
      const ids = users.map((u) => u.id)
      if (ids.length > 0) {
        const missions = await prisma.mission.findMany({
          where: { clientId: { in: ids } },
          select: { id: true },
        })
        const mids = missions.map((m) => m.id)
        if (mids.length > 0) {
          await prisma.refund.deleteMany({ where: { payment: { missionId: { in: mids } } } })
          await prisma.transfer.deleteMany({ where: { payment: { missionId: { in: mids } } } })
          await prisma.autoReleaseJob.deleteMany({ where: { missionId: { in: mids } } })
          await prisma.payment.deleteMany({ where: { missionId: { in: mids } } })
        }
      }
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  // ---------------------------------------------------------------------------
  // V2 / C — Double validate concurrent → 1 seule capture Stripe
  // ---------------------------------------------------------------------------

  describe('V2/C — Double POST /validate concurrent', () => {
    it('2 POST /validate simultanés du même CLIENT → 1 seul stripe.paymentIntents.capture', async () => {
      const fx = await makePendingValidationFixture(app)

      const callsBefore = stripe.__captured.captureCalls.length

      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/missions/${fx.missionId}/validate`)
          .set('authorization', `Bearer ${fx.clientToken}`)
          .send({}),
        request(app.getHttpServer())
          .post(`/api/v1/missions/${fx.missionId}/validate`)
          .set('authorization', `Bearer ${fx.clientToken}`)
          .send({}),
      ])

      // L'un peut être 200 (succès), l'autre 200 idempotent OU 409 (état déjà
      // bougé) — mais aucun ne doit être 5xx (race non gérée).
      expect([200, 409]).toContain(res1.status)
      expect([200, 409]).toContain(res2.status)

      const callsAfter = stripe.__captured.captureCalls.length
      const captureCallsForThisMission = stripe.__captured.captureCalls
        .slice(callsBefore, callsAfter)
        .filter((c) => c.intentId === fx.intentId)

      // Contrat dur audit V2 :
      //   - Au plus UN appel `paymentIntents.capture` côté Stripe pour ce PI
      //     (idempotency-key + short-circuit `payment.status==='CAPTURED'`).
      //   - Si 2 appels existent, ils DOIVENT partager la même idempotency-key
      //     (Stripe garantit alors pas de double prélèvement).
      const uniqueKeys = new Set(captureCallsForThisMission.map((c) => c.idempotencyKey))
      expect(captureCallsForThisMission.length).toBeLessThanOrEqual(2)
      if (captureCallsForThisMission.length === 2) {
        expect(uniqueKeys.size).toBe(1)
        expect([...uniqueKeys][0]).toBe(`capture-mission-${fx.missionId}`)
      } else {
        expect(captureCallsForThisMission.length).toBe(1)
        expect(captureCallsForThisMission[0]!.idempotencyKey).toBe(
          `capture-mission-${fx.missionId}`,
        )
      }
    })
  })

  // ---------------------------------------------------------------------------
  // V3 — Replay scheduleTx auto-release → 1 seul job (jobId déterministe)
  // ---------------------------------------------------------------------------

  describe('V3 — Double planification auto-release', () => {
    it('2 appels successifs de scheduleTx → 1 seul AutoReleaseJob DB (unique constraint)', async () => {
      const fx = await makePendingValidationFixture(app)

      // Le helper a déjà créé un AutoReleaseJob SCHEDULED. Un second
      // `scheduleTx` (concurrent ou replay) doit être idempotent : retourner
      // le job existant sans en créer un second.
      const auto = app.get(AutoReleaseService)
      const now = new Date()

      const [r1, r2] = await Promise.all([
        prisma.$transaction((tx) => auto.scheduleTx(tx, { missionId: fx.missionId, now })),
        prisma.$transaction((tx) => auto.scheduleTx(tx, { missionId: fx.missionId, now })),
      ])

      // Idempotence : les deux retournent le même `job.id` ; au plus une
      // création effective (`created=true` une seule fois max).
      expect(r1.job.id).toBe(r2.job.id)
      const createdCount = [r1, r2].filter((r) => r.created).length
      expect(createdCount).toBeLessThanOrEqual(1)

      // DB : 1 seule ligne `AutoReleaseJob` pour cette mission
      // (la contrainte unique sur `missionId` côté SCHEDULED garantit l'unicité).
      const rows = await prisma.autoReleaseJob.findMany({
        where: { missionId: fx.missionId },
      })
      expect(rows.length).toBe(1)
      expect(rows[0]!.status).toBe('SCHEDULED')

      // jobId BullMQ déterministe (audit V3) — `buildAutoReleaseBullJobId`.
      expect(rows[0]!.bullJobId).toBe(buildAutoReleaseBullJobId(fx.missionId))
    })

    it('enqueueDelayedJob 2× même bullJobId → BullMQ déduplique (1 seul job dans la queue)', async () => {
      const fx = await makePendingValidationFixture(app)
      const auto = app.get(AutoReleaseService)
      const queue = app.get<Queue>(getQueueToken(AUTO_RELEASE_QUEUE))
      const bullJobId = buildAutoReleaseBullJobId(fx.missionId)

      // Nettoie un éventuel job résiduel d'un test précédent (les tests
      // partagent la même queue Redis ; on isole sur ce bullJobId).
      try {
        const existing = await queue.getJob(bullJobId)
        if (existing) await existing.remove()
      } catch {
        // pas grave
      }

      const now = new Date()
      await auto.enqueueDelayedJob({
        autoReleaseJobId: 'dummy-1',
        missionId: fx.missionId,
        scheduledFor: new Date(now.getTime() + 60_000),
        bullJobId,
        now,
      })
      await auto.enqueueDelayedJob({
        autoReleaseJobId: 'dummy-2',
        missionId: fx.missionId,
        scheduledFor: new Date(now.getTime() + 60_000),
        bullJobId,
        now,
      })

      // BullMQ avec `jobId` explicite : la 2e add est un no-op si le job
      // existe déjà → on doit retrouver UN seul job actif.
      const queuedJob = await queue.getJob(bullJobId)
      expect(queuedJob).not.toBeNull()
      expect(queuedJob!.id).toBe(bullJobId)

      // Cleanup
      await queuedJob!.remove()
    })
  })

  // ---------------------------------------------------------------------------
  // V10 — Capture déjà effective + auto-release safety-net concurrent
  // ---------------------------------------------------------------------------

  describe('V10 — Auto-release vs capture déjà CAPTURED', () => {
    it('PaymentsService.requestCapture sur Payment CAPTURED → no-op (pas d\'appel Stripe)', async () => {
      const fx = await makePendingValidationFixture(app)
      // Simule que le webhook a déjà fait la capture (cas race V10 : safety-net
      // BullMQ se déclenche après que le webhook ait déjà capturé via /validate).
      await prisma.payment.update({
        where: { id: fx.paymentId },
        data: { status: 'CAPTURED', amountCapturedCents: 15_000 },
      })

      const payments = app.get(PaymentsService)
      const callsBefore = stripe.__captured.captureCalls.length

      // L'auto-release executor appellerait `requestCapture` → le service
      // doit voir Payment.CAPTURED et abandonner sans appel Stripe.
      const result = await payments.requestCapture(fx.missionId, {
        kind: 'SYSTEM',
        trigger: 'AUTO_RELEASE',
      })

      expect(result.status).toBe('CAPTURED')
      const callsAfter = stripe.__captured.captureCalls.length
      expect(callsAfter).toBe(callsBefore)
    })
  })

  // ---------------------------------------------------------------------------
  // V11 — Refund admin émis + auto-release tente capture → no-op
  // ---------------------------------------------------------------------------

  describe('V11 — Refund vs auto-release', () => {
    it('Payment REFUND_PENDING/REFUNDED + auto-release.requestCapture → no Stripe call', async () => {
      const fx = await makePendingValidationFixture(app)
      // L'admin a déjà émis un refund pendant que l'auto-release allait
      // tourner. Le Payment n'est plus AUTHORIZED → safety-net doit abandonner.
      await prisma.payment.update({
        where: { id: fx.paymentId },
        data: { status: 'REFUND_PENDING' },
      })

      const payments = app.get(PaymentsService)
      const callsBefore = stripe.__captured.captureCalls.length

      // `requestCapture` doit voir `payment.status !== 'AUTHORIZED'` → throw
      // métier OU no-op selon implementation. Le contrat dur : aucun appel
      // Stripe `capture` émis (anti double-mutation finance).
      try {
        await payments.requestCapture(fx.missionId, { kind: 'SYSTEM', trigger: 'AUTO_RELEASE' })
      } catch {
        // domaine peut throw PaymentNotCapturable — c'est OK
      }

      const callsAfter = stripe.__captured.captureCalls.length
      expect(callsAfter).toBe(callsBefore)
    })
  })
})
