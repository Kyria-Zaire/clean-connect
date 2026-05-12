/**
 * Tests d'intégration — `POST /v1/missions/:id/photos/presign` +
 * `POST /v1/missions/:id/photos/confirm` (PRD-003 Ticket 3.3).
 *
 * Couverture (alignée scope CTO §"tests upload auth + replay + expiration + mismatch") :
 *  - presign happy path (PRESTATAIRE assigné).
 *  - presign refusé pour non-assigné (403 PHOTO_FORBIDDEN).
 *  - confirm happy path (Cloudinary stubbé) → Photo persistée + audit.
 *  - confirm idempotent replay (same captureClientUuid + variant) → 201 idempotent: true.
 *  - confirm cross-mission (mission URL ≠ session.missionId) → 409.
 *  - confirm session expirée → 410 PHOTO_UPLOAD_SESSION_EXPIRED.
 *  - confirm tokenDigest mismatch → 409 (session « not found » sémantique).
 *  - GET ne renvoie JAMAIS ORIGINAL côté public (placeholder — sera vérifié Ticket 3.4).
 *
 * Cloudinary SDK : override `CLOUDINARY_CLIENT_TOKEN` par un stub minimaliste.
 * Le binaire n'est jamais uploadé réellement (test = stubbed).
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
import {
  CLOUDINARY_CLIENT_TOKEN,
  CloudinaryResourceNotFoundError,
} from '../../src/modules/photos/cloudinary/cloudinary.client'
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
    getResource: jest.fn(async (publicId: string) => {
      // Par défaut : asset existe. Tests "asset missing" override via spy ci-dessous.
      return {
        publicId,
        format: 'jpeg',
        bytes: 250_000,
        width: 1600,
        height: 1200,
        version: 1,
        resourceType: 'image',
        type: 'private' as const,
      }
    }),
    signedReadUrl: jest.fn(),
  }
}

let cloudinaryStub: ReturnType<typeof buildCloudinaryStub> & {
  getResource: jest.Mock
  signUploadParams: jest.Mock
}

async function buildApp(): Promise<INestApplication> {
  process.env['FF_PAYMENTS_ENABLED'] = 'false'
  process.env['FF_PHOTOS_ENABLED'] = 'true'
  process.env['CLOUDINARY_URL'] = 'cloudinary://itk:its@itcloud'
  process.env['CLOUDINARY_FOLDER_PREFIX'] = 'it'
  process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] = '300'
  process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] = '300'
  process.env['APP_ENV'] = 'recette'
  process.env['NODE_ENV'] = 'recette'
  process.env['DISABLE_THROTTLE'] = 'true'
  __resetEnvCacheForTests()

  cloudinaryStub = buildCloudinaryStub() as never

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STRIPE_CLIENT_TOKEN)
    .useValue({
      paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
      events: { retrieve: jest.fn() },
    })
    .overrideProvider(CLOUDINARY_CLIENT_TOKEN)
    .useValue(cloudinaryStub)
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
  prestataireId: string
  prestataireToken: string
  clientId: string
  otherPrestaToken: string
  otherPrestaId: string
}

async function createMissionWithAssignedPrestataire(app: INestApplication): Promise<MissionFixture> {
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
  const presta = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: {
      city: 'Paris',
      zipCode: '75011',
      street: '1 rue Test Presta',
      lat: 48.86,
      lng: 2.38,
    },
  })
  const otherPresta = await createTestUser(prisma, {
    role: 'PRESTATAIRE',
    base: {
      city: 'Paris',
      zipCode: '75011',
      street: '2 rue Test Other Presta',
      lat: 48.85,
      lng: 2.39,
    },
  })

  const clientToken = await forgeAccessToken(app, { id: client.id, role: 'CLIENT' })
  const prestataireToken = await forgeAccessToken(app, { id: presta.id, role: 'PRESTATAIRE' })
  const otherPrestaToken = await forgeAccessToken(app, { id: otherPresta.id, role: 'PRESTATAIRE' })

  // Crée la mission via HTTP (status DRAFT)
  const draftRes = await request(app.getHttpServer())
    .post('/api/v1/missions')
    .set('authorization', `Bearer ${clientToken}`)
    .send({
      serviceType: 'SOFA',
      address: { street: '11 rue Oberkampf', city: 'Paris', zipCode: '75011', country: 'FR' },
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1_000 + 2 * 60 * 60 * 1_000).toISOString(),
      timeZone: 'Europe/Paris',
      estimatedPriceCents: 15_000,
    })
  expect(draftRes.status).toBe(201)

  // Force la mission en `PUBLISHED` + prestataireId pour shortcut Ticket 3.4.
  // Le test 3.3 n'a pas besoin du workflow accept complet.
  await prisma.mission.update({
    where: { id: draftRes.body.id },
    data: {
      status: 'PUBLISHED',
      prestataireId: presta.id,
      publishedAt: new Date(),
      listingExpiresAt: new Date(Date.now() + 15 * 60 * 1_000),
    },
  })

  return {
    missionId: draftRes.body.id,
    prestataireId: presta.id,
    prestataireToken,
    clientId: client.id,
    otherPrestaId: otherPresta.id,
    otherPrestaToken,
  }
}

const PRESIGN = (missionId: string) => `/api/v1/missions/${missionId}/photos/presign`
const CONFIRM = (missionId: string) => `/api/v1/missions/${missionId}/photos/confirm`

function presignBody(missionId: string, captureClientUuid: string, variant: 'ORIGINAL' | 'DISPLAY' = 'ORIGINAL'): Record<string, unknown> {
  return {
    missionId,
    phase: 'BEFORE',
    variant,
    captureClientUuid,
    bytes: 250_000,
    mimeType: 'image/jpeg',
    gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
  }
}

async function cleanupPhotos(prisma: PrismaService): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { contains: '@cc-test.fr' } },
    select: { id: true },
  })
  const uids = users.map((u) => u.id)
  if (uids.length === 0) return
  const missions = await prisma.mission.findMany({ where: { clientId: { in: uids } }, select: { id: true } })
  const mids = missions.map((m) => m.id)
  if (mids.length === 0) return
  await prisma.photoDeletionLog.deleteMany({ where: { missionId: { in: mids } } })
  await prisma.photo.deleteMany({ where: { missionId: { in: mids } } })
  await prisma.photoUploadSession.deleteMany({ where: { missionId: { in: mids } } })
}

describe('POST /api/v1/missions/:id/photos/{presign|confirm} (PRD-003 Ticket 3.3)', () => {
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    if (app) {
      const prisma = app.get(PrismaService)
      await cleanupPhotos(prisma)
      await cleanupMissions(prisma)
      await app.close()
    }
  })

  it('presign : happy path (PRESTATAIRE assigné) → 201 + sessionToken + cloudinaryParams signés', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = '11111111-1111-4111-8111-111111111111'
    const res = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))

    expect(res.status).toBe(201)
    expect(res.body.photoUploadSessionId).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(res.body.sessionToken).toHaveLength(64)
    expect(res.body.uploadUrl).toContain('api.cloudinary.com')
    expect(res.body.cloudinaryParams.public_id).toContain(captureUuid)
    expect(res.body.cloudinaryParams.public_id).toMatch(/original$/u)
    expect(res.body.cloudinaryParams.type).toBe('private')
    expect(res.body.maxBytes).toBe(10 * 1024 * 1024)
    expect(res.body.allowedMimeTypes).toContain('image/jpeg')

    const prisma = app.get(PrismaService)
    const session = await prisma.photoUploadSession.findUnique({
      where: { id: res.body.photoUploadSessionId },
    })
    expect(session).not.toBeNull()
    expect(session!.uploaderUserId).toBe(fx.prestataireId)
    expect(session!.missionId).toBe(fx.missionId)
    expect(session!.captureClientUuid).toBe(captureUuid)
    expect(session!.consumedAt).toBeNull()
    expect(session!.tokenDigest).toMatch(/^[a-f0-9]{64}$/u)
    // Le token clair n'est PAS stocké (digest only).
    expect(session!.tokenDigest).not.toBe(res.body.sessionToken)
  })

  it('presign : 403 PHOTO_FORBIDDEN pour un PRESTATAIRE non assigné', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = '22222222-2222-4222-8222-222222222222'
    const res = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.otherPrestaToken}`)
      .send(presignBody(fx.missionId, captureUuid))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('PHOTO_FORBIDDEN')
  })

  it('confirm : happy path → 201 idempotent: false + Photo persistée + audit', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = '33333333-3333-4333-8333-333333333333'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))
    expect(presign.status).toBe(201)

    const photoId = '44444444-4444-4444-8444-444444444444'
    const confirm = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send({
        photoUploadSessionId: presign.body.photoUploadSessionId,
        sessionToken: presign.body.sessionToken,
        photoId,
        captureClientUuid: captureUuid,
        cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
        checksumSha256: 'a'.repeat(64),
        imageWidth: 1600,
        imageHeight: 1200,
        bytes: 250_000,
        mimeType: 'image/jpeg',
        gps: { gpsLatitude: 48.86, gpsLongitude: 2.38, gpsAccuracyMeters: 12 },
      })

    expect(confirm.status).toBe(201)
    expect(confirm.body.idempotent).toBe(false)
    expect(confirm.body.photoId).toBe(photoId)
    expect(confirm.body.gpsMissing).toBe(false)
    expect(confirm.body.bytes).toBe(250_000)

    const prisma = app.get(PrismaService)
    const photo = await prisma.photo.findUnique({ where: { id: photoId } })
    expect(photo).not.toBeNull()
    expect(photo!.uploadedByUserId).toBe(fx.prestataireId)
    expect(photo!.variant).toBe('ORIGINAL')
    expect(photo!.type).toBe('BEFORE')
    expect(photo!.cloudinaryPublicId).toBe(presign.body.cloudinaryParams.public_id)
    // ORIGINAL jamais exposé via URL publique → on stocke un legacy URL non publique.
    expect(photo!.url).toMatch(/^cloudinary:\/\/private\//u)

    const events = await prisma.missionEvent.findMany({
      where: { missionId: fx.missionId, type: 'PHOTO_CONFIRMED' },
    })
    expect(events.length).toBe(1)

    const session = await prisma.photoUploadSession.findUnique({
      where: { id: presign.body.photoUploadSessionId },
    })
    expect(session!.consumedAt).not.toBeNull()
  })

  it('confirm : replay (même captureClientUuid + variant) → 201 idempotent: true (sans muter)', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = '55555555-5555-4555-8555-555555555555'
    const photoId = '66666666-6666-4666-8666-666666666666'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))

    const payload = {
      photoUploadSessionId: presign.body.photoUploadSessionId,
      sessionToken: presign.body.sessionToken,
      photoId,
      captureClientUuid: captureUuid,
      cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
      checksumSha256: 'b'.repeat(64),
      imageWidth: 1600,
      imageHeight: 1200,
      bytes: 250_000,
      mimeType: 'image/jpeg',
      gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
    }

    const first = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(payload)
    expect(first.status).toBe(201)
    expect(first.body.idempotent).toBe(false)

    // Replay : même presign + confirm payload → idempotent
    const replay = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(payload)
    expect(replay.status).toBe(201)
    expect(replay.body.idempotent).toBe(true)
    expect(replay.body.photoId).toBe(photoId)
  })

  it('confirm : 409 si mission URL ≠ session.missionId (anti cross-mission)', async () => {
    // Le check anti cross-mission n'a de sens que si le PRESTATAIRE est légitimement
    // assigné aux 2 missions (sinon le RBAC bloque en 403 avant même d'évaluer la session).
    // On force donc la mission B à pointer le MÊME prestataire que la mission A.
    const fxA = await createMissionWithAssignedPrestataire(app)
    const fxB = await createMissionWithAssignedPrestataire(app)
    const prisma = app.get(PrismaService)
    await prisma.mission.update({
      where: { id: fxB.missionId },
      data: { prestataireId: fxA.prestataireId },
    })

    const captureUuid = '77777777-7777-4777-8777-777777777777'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fxA.missionId))
      .set('authorization', `Bearer ${fxA.prestataireToken}`)
      .send(presignBody(fxA.missionId, captureUuid))
    expect(presign.status).toBe(201)

    // Le presta tente de confirmer la session de A en frappant l'URL de B.
    const res = await request(app.getHttpServer())
      .post(CONFIRM(fxB.missionId))
      .set('authorization', `Bearer ${fxA.prestataireToken}`)
      .send({
        photoUploadSessionId: presign.body.photoUploadSessionId,
        sessionToken: presign.body.sessionToken,
        photoId: '88888888-8888-4888-8888-888888888888',
        captureClientUuid: captureUuid,
        cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
        checksumSha256: 'c'.repeat(64),
        imageWidth: 1600,
        imageHeight: 1200,
        bytes: 250_000,
        mimeType: 'image/jpeg',
        gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('PHOTO_UPLOAD_SESSION_MISSION_MISMATCH')
  })

  it('confirm : 409 si sessionToken invalide (digest mismatch — anti session-id leak)', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = '99999999-9999-4999-8999-999999999999'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))

    const res = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send({
        photoUploadSessionId: presign.body.photoUploadSessionId,
        sessionToken: 'forged-token-not-matching-digest-aaaa-bbbb-cccc', // ≠ vrai token
        photoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        captureClientUuid: captureUuid,
        cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
        checksumSha256: 'd'.repeat(64),
        imageWidth: 1600,
        imageHeight: 1200,
        bytes: 250_000,
        mimeType: 'image/jpeg',
        gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED')
  })

  it('confirm : 410 si session expirée (mute expiresAt < now en DB)', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))

    const prisma = app.get(PrismaService)
    await prisma.photoUploadSession.update({
      where: { id: presign.body.photoUploadSessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    const res = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send({
        photoUploadSessionId: presign.body.photoUploadSessionId,
        sessionToken: presign.body.sessionToken,
        photoId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        captureClientUuid: captureUuid,
        cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
        checksumSha256: 'e'.repeat(64),
        imageWidth: 1600,
        imageHeight: 1200,
        bytes: 250_000,
        mimeType: 'image/jpeg',
        gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
      })
    expect(res.status).toBe(410)
    expect(res.body.error).toBe('PHOTO_UPLOAD_SESSION_EXPIRED')
  })

  it('confirm : 422 PHOTO_INVALID_STATE si Cloudinary signale asset manquant', async () => {
    const fx = await createMissionWithAssignedPrestataire(app)
    const captureUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const presign = await request(app.getHttpServer())
      .post(PRESIGN(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send(presignBody(fx.missionId, captureUuid))

    cloudinaryStub.getResource.mockImplementationOnce(async (publicId: string) => {
      throw new CloudinaryResourceNotFoundError(publicId)
    })

    const res = await request(app.getHttpServer())
      .post(CONFIRM(fx.missionId))
      .set('authorization', `Bearer ${fx.prestataireToken}`)
      .send({
        photoUploadSessionId: presign.body.photoUploadSessionId,
        sessionToken: presign.body.sessionToken,
        photoId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        captureClientUuid: captureUuid,
        cloudinaryPublicId: presign.body.cloudinaryParams.public_id,
        checksumSha256: 'f'.repeat(64),
        imageWidth: 1600,
        imageHeight: 1200,
        bytes: 250_000,
        mimeType: 'image/jpeg',
        gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
      })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('PHOTO_INVALID_STATE')
  })
})
