/**
 * PRD-003 Ticket 3.6-bis — Verify final : RBAC photos + quotas BEFORE/AFTER.
 *
 * Couverture grille CTO §6.1 :
 *   - V4 : `POST /missions/:id/photos/presign` sans Authorization → 401.
 *   - V6 : `POST /missions/:id/complete` avec 5 AFTER + 0 BEFORE → 409
 *          `MISSION_PHOTOS_INSUFFICIENT` (reason `INSUFFICIENT_BEFORE`).
 *   - F  : grille quotas exactes (2/3 BEFORE et 4/5 AFTER) — la transition
 *          ACCEPTED → CLIENT_VALIDATION_PENDING ne passe que pour ≥3 BEFORE et
 *          ≥5 AFTER ; sinon 409 distinct sur la cause manquante.
 *   - H  : `POST /presign` retourne un signed URL Cloudinary à durée bornée
 *          (TTL ≤ 5 min = 300 s) — `expiresAt - now ≤ 300 s`.
 *
 * Méthodologie :
 *   - Cloudinary stubbé (pas d'upload réel).
 *   - Les Photo de quota sont insérées directement en DB (variant `DISPLAY`
 *     comme requis par `MissionPhotoQuotaService.check`).
 *   - Aucun appel Stripe ici (`FF_PAYMENTS_ENABLED=false`).
 */

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { CLOUDINARY_CLIENT_TOKEN } from '../../src/modules/photos/cloudinary/cloudinary.client'
import { STRIPE_CLIENT_TOKEN } from '../../src/modules/payments/stripe/stripe.client'

import { cleanupMissions, createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(180_000)

function buildCloudinaryStub(): unknown {
  return {
    isReady: () => true,
    signUploadParams: (input: { folder: string; publicId: string; mimeType: string; maxBytes: number; timestamp?: number }) => ({
      uploadUrl: 'https://api.cloudinary.com/v1_1/it-test-cloud/image/upload',
      cloudName: 'it-test-cloud',
      apiKey: 'it-test-key',
      publicId: input.publicId,
      folder: input.folder,
      type: 'private' as const,
      timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
      signature: 'a'.repeat(40),
      signatureAlgorithm: 'sha1' as const,
      mimeType: input.mimeType,
      maxBytes: input.maxBytes,
    }),
    getResource: jest.fn(async (publicId: string) => ({
      publicId,
      format: 'jpeg',
      bytes: 250_000,
      width: 1600,
      height: 1200,
      version: 1,
      resourceType: 'image',
      type: 'private' as const,
    })),
    signedReadUrl: jest.fn(),
  }
}

async function buildApp(): Promise<INestApplication> {
  process.env['FF_PAYMENTS_ENABLED'] = 'false'
  process.env['FF_PHOTOS_ENABLED'] = 'true'
  process.env['CLOUDINARY_URL'] = 'cloudinary://itk:its@itcloud'
  process.env['CLOUDINARY_FOLDER_PREFIX'] = 'it36b'
  process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] = '300'
  process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] = '300'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  __resetEnvCacheForTests()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STRIPE_CLIENT_TOKEN)
    .useValue({
      paymentIntents: { create: jest.fn(), retrieve: jest.fn(), capture: jest.fn() },
      transfers: { create: jest.fn(), retrieve: jest.fn() },
      refunds: { create: jest.fn() },
      events: { retrieve: jest.fn() },
      webhooks: { constructEvent: jest.fn() },
    })
    .overrideProvider(CLOUDINARY_CLIENT_TOKEN)
    .useValue(buildCloudinaryStub())
    .compile()

  const app = moduleRef.createNestApplication({ rawBody: true })
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

interface MissionFx {
  missionId: string
  prestataireId: string
  prestataireToken: string
  clientId: string
}

async function createAcceptedMission(app: INestApplication): Promise<MissionFx> {
  const prisma = app.get(PrismaService)
  const client = await createTestUser(prisma, {
    role: 'CLIENT',
    base: { city: 'Paris', zipCode: '75011', street: '20 rue Test', lat: 48.8638, lng: 2.3777 },
  })
  const presta = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: { city: 'Paris', zipCode: '75010', street: '21 rue Test', lat: 48.871, lng: 2.366 },
  })

  const clientToken = await forgeAccessToken(app, { id: client.id, role: 'CLIENT' })
  const prestataireToken = await forgeAccessToken(app, { id: presta.id, role: 'PRESTATAIRE' })

  const draft = await request(app.getHttpServer())
    .post('/api/v1/missions')
    .set('authorization', `Bearer ${clientToken}`)
    .send({
      serviceType: 'SOFA',
      address: { street: '20 rue Test', city: 'Paris', zipCode: '75011', country: 'FR' },
      startAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents: 15_000,
    })
  expect(draft.status).toBe(201)

  // Force la mission en ACCEPTED + assigne le prestataire (shortcut Build 3.4).
  await prisma.mission.update({
    where: { id: draft.body.id },
    data: {
      status: 'ACCEPTED',
      prestataireId: presta.id,
      publishedAt: new Date(),
      listingExpiresAt: new Date(Date.now() + 15 * 60_000),
    },
  })

  return {
    missionId: draft.body.id,
    prestataireId: presta.id,
    prestataireToken,
    clientId: client.id,
  }
}

/**
 * Insère N photos « comptables » (variant DISPLAY syncées). On insère aussi
 * la variante ORIGINAL pour respecter la contrainte UNIQUE (mission, capture, variant)
 * — pas obligatoire fonctionnellement, mais représente un dataset réaliste.
 */
async function seedPhotos(
  prisma: PrismaService,
  missionId: string,
  uploadedByUserId: string,
  type: 'BEFORE' | 'AFTER',
  count: number,
): Promise<void> {
  const now = new Date()
  for (let i = 0; i < count; i += 1) {
    const captureClientUuid = randomUUID()
    const photoId = randomUUID()
    await prisma.photo.create({
      data: {
        id: photoId,
        missionId,
        uploadedByUserId,
        captureClientUuid,
        variant: 'DISPLAY',
        type,
        url: `https://res.cloudinary.com/it36b/image/upload/missions/${missionId}/${type.toLowerCase()}/${captureClientUuid}/display.jpg`,
        cloudinaryPublicId: `it36b/missions/${missionId}/${type.toLowerCase()}/${captureClientUuid}/display`,
        bytes: 250_000,
        imageWidth: 1600,
        imageHeight: 1200,
        syncedAt: now,
      },
    })
  }
}

async function cleanupPhotos(prisma: PrismaService): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { contains: '@cc-test.fr' } },
    select: { id: true },
  })
  const uids = users.map((u) => u.id)
  if (uids.length === 0) return
  const missions = await prisma.mission.findMany({
    where: { clientId: { in: uids } },
    select: { id: true },
  })
  const mids = missions.map((m) => m.id)
  if (mids.length === 0) return
  await prisma.photoDeletionLog.deleteMany({ where: { missionId: { in: mids } } })
  await prisma.photo.deleteMany({ where: { missionId: { in: mids } } })
  await prisma.photoUploadSession.deleteMany({ where: { missionId: { in: mids } } })
  await prisma.autoReleaseJob.deleteMany({ where: { missionId: { in: mids } } })
}

describe('PRD-003 Ticket 3.6-bis — Photos RBAC + Quotas (Verify final)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    if (app) {
      await cleanupPhotos(prisma)
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  // ---------------------------------------------------------------------------
  // V4 — POST /presign sans JWT → 401
  // ---------------------------------------------------------------------------

  describe('V4 — Upload sans authentification', () => {
    it('POST /missions/:id/photos/presign sans Authorization → 401', async () => {
      const fx = await createAcceptedMission(app)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/photos/presign`)
        .send({
          missionId: fx.missionId,
          phase: 'BEFORE',
          variant: 'ORIGINAL',
          captureClientUuid: '11111111-1111-4111-8111-111111111111',
          bytes: 250_000,
          mimeType: 'image/jpeg',
          gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
        })
      expect(res.status).toBe(401)
    })

    it('POST /photos/confirm sans Authorization → 401', async () => {
      const fx = await createAcceptedMission(app)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/photos/confirm`)
        .send({
          photoUploadSessionId: '00000000-0000-4000-8000-000000000000',
          sessionToken: 'a'.repeat(64),
          captureClientUuid: '11111111-1111-4111-8111-111111111111',
          cloudinaryPublicId: 'dummy',
          mimeType: 'image/jpeg',
          bytes: 250_000,
        })
      expect(res.status).toBe(401)
    })
  })

  // ---------------------------------------------------------------------------
  // H — Signed URL TTL ≤ 5 min (300 s)
  // ---------------------------------------------------------------------------

  describe('H — Signed URL Cloudinary TTL borné à 5 min', () => {
    it('POST /presign : expiresAt − now ≤ 300 s ; cloudinaryParams.timestamp récent (< 60 s)', async () => {
      const fx = await createAcceptedMission(app)

      // La mission doit être PUBLISHED/ACCEPTED + prestataire assigné pour
      // que `assertCanUploadForMission` passe (rule photos.service).
      await prisma.mission.update({
        where: { id: fx.missionId },
        data: { status: 'PUBLISHED', prestataireId: fx.prestataireId },
      })

      const t0 = Date.now()
      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/photos/presign`)
        .set('authorization', `Bearer ${fx.prestataireToken}`)
        .send({
          missionId: fx.missionId,
          phase: 'BEFORE',
          variant: 'ORIGINAL',
          captureClientUuid: 'b1111111-1111-4111-8111-111111111111',
          bytes: 250_000,
          mimeType: 'image/jpeg',
          gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
        })

      expect(res.status).toBe(201)
      const expiresAt = new Date(res.body.expiresAt).getTime()
      const ttlMs = expiresAt - t0
      expect(ttlMs).toBeGreaterThan(0)
      // Tolère 5 s de marge clock skew tests (CI Linux).
      expect(ttlMs).toBeLessThanOrEqual(300 * 1000 + 5_000)

      // Cloudinary stamp utilisé pour la signature : < 60 s d'ancienneté.
      const stampMs = Number(res.body.cloudinaryParams.timestamp) * 1000
      expect(t0 - stampMs).toBeLessThan(60_000)
    })
  })

  // ---------------------------------------------------------------------------
  // V6 + F — Quotas BEFORE/AFTER pour POST /complete
  // ---------------------------------------------------------------------------

  describe('V6 / F — Quotas photos pour POST /missions/:id/complete', () => {
    it('V6 : 0 BEFORE + 5 AFTER → 409 MISSION_PHOTOS_INSUFFICIENT (INSUFFICIENT_BEFORE)', async () => {
      const fx = await createAcceptedMission(app)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'AFTER', 5)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/complete`)
        .set('authorization', `Bearer ${fx.prestataireToken}`)
        .send({})

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('MISSION_PHOTOS_INSUFFICIENT')
      expect(String(res.body.reason)).toContain('INSUFFICIENT_BEFORE')
      expect(String(res.body.reason)).toContain('before=0')
      expect(String(res.body.reason)).toContain('after=5')
    })

    it('F : 2 BEFORE + 5 AFTER → 409 MISSION_PHOTOS_INSUFFICIENT (INSUFFICIENT_BEFORE)', async () => {
      const fx = await createAcceptedMission(app)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'BEFORE', 2)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'AFTER', 5)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/complete`)
        .set('authorization', `Bearer ${fx.prestataireToken}`)
        .send({})

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('MISSION_PHOTOS_INSUFFICIENT')
      expect(String(res.body.reason)).toContain('INSUFFICIENT_BEFORE')
    })

    it('F : 3 BEFORE + 4 AFTER → 409 MISSION_PHOTOS_INSUFFICIENT (INSUFFICIENT_AFTER)', async () => {
      const fx = await createAcceptedMission(app)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'BEFORE', 3)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'AFTER', 4)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/complete`)
        .set('authorization', `Bearer ${fx.prestataireToken}`)
        .send({})

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('MISSION_PHOTOS_INSUFFICIENT')
      expect(String(res.body.reason)).toContain('INSUFFICIENT_AFTER')
    })

    it('F : 3 BEFORE + 5 AFTER → 200 (transition ACCEPTED → CLIENT_VALIDATION_PENDING)', async () => {
      const fx = await createAcceptedMission(app)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'BEFORE', 3)
      await seedPhotos(prisma, fx.missionId, fx.prestataireId, 'AFTER', 5)

      const res = await request(app.getHttpServer())
        .post(`/api/v1/missions/${fx.missionId}/complete`)
        .set('authorization', `Bearer ${fx.prestataireToken}`)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body.mission.status).toBe('CLIENT_VALIDATION_PENDING')
      expect(res.body.idempotent).toBe(false)

      const reloaded = await prisma.mission.findUnique({ where: { id: fx.missionId } })
      expect(reloaded!.status).toBe('CLIENT_VALIDATION_PENDING')
    })
  })
})
