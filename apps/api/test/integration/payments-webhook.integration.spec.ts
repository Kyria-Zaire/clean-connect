/**
 * Tests d'intégration — `POST /api/v1/webhooks/stripe` (PRD-003 Ticket 3.1).
 *
 * Couvre les invariants critiques (audit Verify V1 pré-revue sécurité) :
 *   - Signature HMAC verifiée AVANT toute désérialisation (400)
 *   - Replay même `stripe_event_id` → 202 idempotent (DB unique constraint)
 *   - Livemode mismatch (event.livemode=true vs APP_ENV=recette) → 400
 *   - FF_PAYMENTS_ENABLED=false → 503 (gating réel)
 *   - Happy path : insert DB + enqueue BullMQ + 202
 *
 * Prérequis :
 *   - Postgres test (port 5433) — `pnpm db:test:up`
 *   - Redis test (port 6380)
 *   - Migrations Prisma appliquées (`prisma migrate deploy`)
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

jest.setTimeout(180_000)

const WEBHOOK_SECRET = 'whsec_integration_secret_min_32chars_xxxxxx'
const ROUTE = '/api/v1/webhooks/stripe'

/**
 * Construit un raw body + signature HMAC valide identique à ce que Stripe envoie.
 * On ne mocke jamais `constructEvent` — on calque exactement son algorithme.
 */
function buildSignedRequest(opts: {
  livemode?: boolean
  eventId: string
  type?: string
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
    data: { object: { id: 'pi_test_int_123' } },
  }
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8')
  const signedPayload = `${ts}.${rawBody.toString('utf8')}`
  const hmac = createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex')
  return { rawBody, signature: `t=${ts},v1=${hmac}` }
}

async function buildApp(opts: { paymentsEnabled: boolean; appEnv?: string }): Promise<INestApplication> {
  process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  process.env['STRIPE_API_VERSION'] = '2025-02-24.acacia'
  process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] = '300'
  process.env['FF_PAYMENTS_ENABLED'] = opts.paymentsEnabled ? 'true' : 'false'
  process.env['APP_ENV'] = opts.appEnv ?? 'recette'
  process.env['NODE_ENV'] = opts.appEnv ?? 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'

  // Force re-validation de l'env : un test précédent peut avoir caché une valeur
  // (ex: FF_PAYMENTS_ENABLED=false dans le bloc 'feature flag' juste avant).
  __resetEnvCacheForTests()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication({ rawBody: true })
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

describe('POST /api/v1/webhooks/stripe (PRD-003 Ticket 3.1)', () => {
  let app: INestApplication | undefined
  let prisma: PrismaService | undefined

  async function cleanupEvent(stripeEventId: string): Promise<void> {
    if (!prisma) return
    try {
      await prisma.stripeWebhookEvent.delete({ where: { stripeEventId } })
    } catch {
      // déjà supprimé / pas inséré
    }
  }

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
      prisma = undefined
    }
  })

  describe('feature flag', () => {
    it('renvoie 503 PAYMENTS_DISABLED si FF_PAYMENTS_ENABLED=false', async () => {
      app = await buildApp({ paymentsEnabled: false })
      prisma = app.get(PrismaService)
      const { rawBody, signature } = buildSignedRequest({ eventId: 'evt_int_ff_off' })
      const res = await request(app.getHttpServer())
        .post(ROUTE)
        .set('stripe-signature', signature)
        .set('content-type', 'application/json')
        .send(rawBody.toString('utf8'))
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('PAYMENTS_DISABLED')
      // Aucune ligne ne doit avoir été insérée.
      const row = await prisma.stripeWebhookEvent.findUnique({
        where: { stripeEventId: 'evt_int_ff_off' },
      })
      expect(row).toBeNull()
    })
  })

  describe('avec FF_PAYMENTS_ENABLED=true', () => {
    beforeEach(async () => {
      app = await buildApp({ paymentsEnabled: true, appEnv: 'recette' })
      prisma = app.get(PrismaService)
    })

    /**
     * Helper supertest — passe le rawBody EN STRING (et non Buffer) pour éviter
     * que `supertest.send(Buffer)` ne re-sérialise le buffer en `{"type":"Buffer", ...}`
     * sous content-type application/json. La string est envoyée verbatim, ce qui
     * préserve l'empreinte HMAC.
     */
    async function postWebhook(rawBody: Buffer, signature?: string) {
      let req = request(app!.getHttpServer())
        .post(ROUTE)
        .set('content-type', 'application/json')
      if (signature) req = req.set('stripe-signature', signature)
      return req.send(rawBody.toString('utf8'))
    }

    it('renvoie 400 WEBHOOK_INVALID_SIGNATURE si signature absente', async () => {
      const { rawBody } = buildSignedRequest({ eventId: 'evt_int_no_sig' })
      const res = await postWebhook(rawBody)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('WEBHOOK_INVALID_SIGNATURE')
    })

    it('renvoie 400 WEBHOOK_INVALID_SIGNATURE si HMAC invalide', async () => {
      const { rawBody } = buildSignedRequest({ eventId: 'evt_int_bad_sig' })
      const res = await postWebhook(rawBody, 't=1700000000,v1=deadbeef')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('WEBHOOK_INVALID_SIGNATURE')
    })

    it('renvoie 400 WEBHOOK_LIVEMODE_MISMATCH si event.livemode=true en recette', async () => {
      const { rawBody, signature } = buildSignedRequest({
        eventId: 'evt_int_livemode_mismatch',
        livemode: true,
      })
      const res = await postWebhook(rawBody, signature)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('WEBHOOK_LIVEMODE_MISMATCH')
    })

    it('renvoie 202 accepted=true sur happy path + insert DB + enqueue', async () => {
      const eventId = `evt_int_happy_${Date.now()}`
      const { rawBody, signature } = buildSignedRequest({ eventId, livemode: false })
      const res = await postWebhook(rawBody, signature)
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ accepted: true, idempotent: false, eventId })

      const row = await prisma!.stripeWebhookEvent.findUnique({ where: { stripeEventId: eventId } })
      expect(row).not.toBeNull()
      expect(row!.type).toBe('payment_intent.succeeded')
      expect(row!.livemode).toBe(false)
      expect(row!.payloadHash).toMatch(/^[a-f0-9]{64}$/u)
      // Le processor peut tourner avant l'assertion → on accepte tous les états
      // non-terminaux. Le test du worker en lui-même est couvert ailleurs.
      expect(['PENDING', 'PROCESSING', 'PROCESSED']).toContain(row!.processingStatus)
      await cleanupEvent(eventId)
    })

    it('renvoie 202 idempotent=true si rejouée (même stripe_event_id)', async () => {
      const eventId = `evt_int_replay_${Date.now()}`
      const { rawBody, signature } = buildSignedRequest({ eventId, livemode: false })

      const first = await postWebhook(rawBody, signature)
      expect(first.status).toBe(202)
      expect(first.body.idempotent).toBe(false)

      const second = await postWebhook(rawBody, signature)
      expect(second.status).toBe(202)
      expect(second.body.idempotent).toBe(true)
      expect(second.body.eventId).toBe(eventId)

      // Une seule ligne DB malgré 2 envois.
      const rows = await prisma!.stripeWebhookEvent.findMany({
        where: { stripeEventId: eventId },
      })
      expect(rows).toHaveLength(1)
      await cleanupEvent(eventId)
    })
  })
})
