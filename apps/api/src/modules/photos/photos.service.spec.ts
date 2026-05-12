/**
 * Tests unitaires — `PhotosService` (PRD-003 Ticket 3.3).
 *
 * Couverture (cf. user_query CTO §"tests obligatoires") :
 *  - presign : FF off → 503 / mission missing → 404 / non assigné → 403 / OK.
 *  - confirm : FF off → 503 / session not found ou ID forgé → 409 /
 *    mission mismatch → 409 / capture UUID mismatch → 409 / cloudinary public_id
 *    mismatch → 409 / cloudinary asset missing → 422 / session expirée → 410 /
 *    session consumed (race) → 409 / replay idempotent → 201 idempotent:true /
 *    happy path → 201 idempotent:false / Cloudinary bytes > session.maxBytes → 400.
 */

import type { Mission, Photo, PhotoUploadSession, Prisma, Role } from '@prisma/client'

import { __resetEnvCacheForTests } from '../../common/config/env'
import type { PrismaService } from '../../common/prisma/prisma.service'
import type { MissionEventService } from '../missions/services/mission-event.service'

import { CloudinaryClient, CloudinaryResourceNotFoundError } from './cloudinary/cloudinary.client'
import {
  MissionNotFoundForPhotoException,
  PhotoCaptureUuidMismatchException,
  PhotoCloudinaryAssetMissingException,
  PhotoCloudinaryPublicIdMismatchException,
  PhotoForbiddenException,
  PhotoMaxBytesExceededException,
  PhotoUploadSessionAlreadyConsumedException,
  PhotoUploadSessionExpiredException,
  PhotoUploadSessionMissionMismatchException,
  PhotosDisabledException,
} from './photos.errors'
import type { PhotosRepository } from './photos.repository'
import { PhotosService } from './photos.service'

const MISSION_ID = '00000000-0000-4000-8000-000000000001'
const PRESTA_ID = '00000000-0000-4000-8000-0000000000aa'
const OTHER_PRESTA_ID = '00000000-0000-4000-8000-0000000000bb'
const CAPTURE_UUID = '00000000-0000-4000-8000-0000000000cc'
const PHOTO_ID = '00000000-0000-4000-8000-0000000000dd'
const SESSION_ID = '00000000-0000-4000-8000-0000000000ee'

const VALID_TOKEN_SAMPLE = 'a'.repeat(64)
const VALID_TOKEN_DIGEST = CloudinaryClient.digestToken(VALID_TOKEN_SAMPLE)

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    missionNumber: 'CC-2026-000001',
    status: 'PUBLISHED',
    serviceType: 'SOFA',
    clientId: '00000000-0000-4000-8000-0000000000ff',
    prestataireId: PRESTA_ID,
    addressId: '00000000-0000-4000-8000-000000000000',
    startAt: new Date('2026-06-01T10:00:00Z'),
    endAt: new Date('2026-06-01T12:00:00Z'),
    timeZone: 'Europe/Paris',
    isAsap: false,
    estimatedPriceCents: 12_000,
    publishedAt: new Date('2026-05-12T10:00:00Z'),
    listingExpiresAt: new Date('2026-05-12T10:15:00Z'),
    createdAt: new Date('2026-05-12T10:00:00Z'),
    updatedAt: new Date('2026-05-12T10:00:00Z'),
    ...overrides,
  }
}

function buildSession(overrides: Partial<PhotoUploadSession> = {}): PhotoUploadSession {
  const now = Date.now()
  return {
    id: SESSION_ID,
    missionId: MISSION_ID,
    uploaderUserId: PRESTA_ID,
    phase: 'BEFORE',
    variant: 'ORIGINAL',
    captureClientUuid: CAPTURE_UUID,
    tokenDigest: VALID_TOKEN_DIGEST,
    expiresAt: new Date(now + 60_000),
    consumedAt: null,
    maxBytes: 10 * 1024 * 1024,
    mimeType: 'image/jpeg',
    cloudinaryPublicId: 'unit/missions/m1/before/c1/original',
    createdAt: new Date(now),
    ...overrides,
  }
}

function buildPhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: PHOTO_ID,
    missionId: MISSION_ID,
    uploadedByUserId: PRESTA_ID,
    type: 'BEFORE',
    url: 'cloudinary://private/v1/unit/missions/m1/before/c1/original',
    metadata: {},
    variant: 'ORIGINAL',
    captureClientUuid: CAPTURE_UUID,
    photoUploadSessionId: SESSION_ID,
    cloudinaryPublicId: 'unit/missions/m1/before/c1/original',
    checksumSha256: 'a'.repeat(64),
    gpsLatitude: null,
    gpsLongitude: null,
    gpsAccuracyMeters: null,
    gpsMissing: true,
    flagSuspicious: false,
    syncedAt: new Date('2026-05-12T10:30:00Z'),
    imageWidth: 1600,
    imageHeight: 1200,
    bytes: 250_000,
    deletedAt: null,
    createdAt: new Date('2026-05-12T10:30:00Z'),
    ...overrides,
  }
}

interface Harness {
  service: PhotosService
  photosRepo: jest.Mocked<PhotosRepository>
  cloudinary: jest.Mocked<CloudinaryClient>
  prismaTransaction: jest.Mock
  prismaTxPhoto: { findUnique: jest.Mock }
}

function buildHarness(opts: {
  photosEnabled?: boolean
  mission?: Mission | null
  session?: PhotoUploadSession | null
  existingPhoto?: Photo | null
  markConsumedResult?: number
  resource?: {
    publicId: string
    format: string
    bytes: number
    width: number
    height: number
    version: number
  } | 'NOT_FOUND'
} = {}): Harness {
  process.env['NODE_ENV'] = 'development'
  process.env['APP_ENV'] = 'development'
  process.env['DATABASE_URL'] = 'postgresql://unit:unit@localhost:5499/unit'
  process.env['REDIS_URL'] = 'redis://localhost:6399'
  process.env['CORS_ORIGINS'] = 'http://localhost:5173'
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48)
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48)
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_photo_unit'
  process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_photo_unit_secret_min_32_chars_aaa'
  process.env['STRIPE_API_VERSION'] = '2025-02-24.acacia'
  process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] = '300'
  process.env['APP_VERSION'] = '0.0.0-test'
  process.env['FF_PAYMENTS_ENABLED'] = 'false'
  process.env['CLOUDINARY_URL'] = 'cloudinary://k:s@cn'
  process.env['CLOUDINARY_FOLDER_PREFIX'] = 'unit'
  process.env['FF_PHOTOS_ENABLED'] = opts.photosEnabled === false ? 'false' : 'true'
  process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] = '300'
  process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] = '300'

  __resetEnvCacheForTests()

  const photosRepo = {
    createSession: jest.fn().mockImplementation(async (input) =>
      buildSession({
        id: SESSION_ID,
        missionId: input.missionId,
        uploaderUserId: input.uploaderUserId,
        phase: input.phase,
        variant: input.variant,
        captureClientUuid: input.captureClientUuid,
        tokenDigest: input.tokenDigest,
        expiresAt: input.expiresAt,
        mimeType: input.mimeType,
        cloudinaryPublicId: input.cloudinaryPublicId,
        maxBytes: input.maxBytes,
      }),
    ),
    findSessionByTokenDigest: jest.fn().mockResolvedValue(opts.session ?? null),
    findSessionById: jest.fn(),
    findPhotoByCapture: jest.fn().mockResolvedValue(opts.existingPhoto ?? null),
    markSessionConsumedTx: jest.fn().mockResolvedValue(opts.markConsumedResult ?? 1),
    createPhotoTx: jest.fn().mockImplementation(async (_tx, input) => buildPhoto({
      id: input.id,
      uploadedByUserId: input.uploadedByUserId,
      cloudinaryPublicId: input.cloudinaryPublicId,
      bytes: input.bytes,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      syncedAt: input.syncedAt,
      checksumSha256: input.checksumSha256,
      gpsLatitude: input.gpsLatitude as unknown as Photo['gpsLatitude'],
      gpsLongitude: input.gpsLongitude as unknown as Photo['gpsLongitude'],
      gpsAccuracyMeters: input.gpsAccuracyMeters,
      gpsMissing: input.gpsMissing,
    })),
  } as unknown as jest.Mocked<PhotosRepository>

  const cloudinary = {
    isReady: jest.fn().mockReturnValue(true),
    signUploadParams: jest.fn().mockReturnValue({
      uploadUrl: 'https://api.cloudinary.com/v1_1/cn/image/upload',
      cloudName: 'cn',
      apiKey: 'k',
      publicId: 'unit/missions/m1/before/c1/original',
      folder: 'unit/missions/m1/before/c1',
      type: 'private' as const,
      timestamp: 1_700_000_000,
      signature: 'abc1234567890abcdef',
      signatureAlgorithm: 'sha1' as const,
      mimeType: 'image/jpeg',
      maxBytes: 10 * 1024 * 1024,
    }),
    getResource: jest.fn().mockImplementation(async (publicId: string) => {
      if (opts.resource === 'NOT_FOUND') {
        throw new CloudinaryResourceNotFoundError(publicId)
      }
      return opts.resource ?? {
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
  } as unknown as jest.Mocked<CloudinaryClient>

  const prismaTxPhoto = { findUnique: jest.fn() }
  const prismaTransaction = jest.fn().mockImplementation(async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    cb({ photo: prismaTxPhoto } as unknown as Prisma.TransactionClient),
  )

  const prisma = {
    $transaction: prismaTransaction,
    mission: {
      findUnique: jest.fn().mockResolvedValue(opts.mission === undefined ? buildMission() : opts.mission),
    },
  } as unknown as PrismaService

  const missionEvents = {
    record: jest.fn().mockResolvedValue(undefined),
    recordTx: jest.fn().mockResolvedValue(undefined),
  } as unknown as MissionEventService

  const service = new PhotosService(prisma, photosRepo, missionEvents, cloudinary)

  return { service, photosRepo, cloudinary, prismaTransaction, prismaTxPhoto }
}

function presignInput(overrides: Record<string, unknown> = {}) {
  return {
    missionId: MISSION_ID,
    phase: 'BEFORE' as const,
    variant: 'ORIGINAL' as const,
    captureClientUuid: CAPTURE_UUID,
    bytes: 250_000,
    mimeType: 'image/jpeg' as const,
    gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
    ...overrides,
  }
}

function confirmInput(overrides: Record<string, unknown> = {}) {
  return {
    photoUploadSessionId: SESSION_ID,
    sessionToken: VALID_TOKEN_SAMPLE,
    photoId: PHOTO_ID,
    captureClientUuid: CAPTURE_UUID,
    cloudinaryPublicId: 'unit/missions/m1/before/c1/original',
    checksumSha256: 'a'.repeat(64),
    imageWidth: 1600,
    imageHeight: 1200,
    bytes: 250_000,
    mimeType: 'image/jpeg' as const,
    gps: { gpsLatitude: null, gpsLongitude: null, gpsAccuracyMeters: null },
    ...overrides,
  }
}

const actor = { id: PRESTA_ID, role: 'PRESTATAIRE' as Role }
const otherActor = { id: OTHER_PRESTA_ID, role: 'PRESTATAIRE' as Role }
const adminActor = { id: 'admin-id', role: 'ADMIN' as Role }

describe('PhotosService.presign (PRD-003 Ticket 3.3)', () => {
  it('503 PHOTOS_DISABLED si FF_PHOTOS_ENABLED=false', async () => {
    const { service } = buildHarness({ photosEnabled: false })
    await expect(service.presign(MISSION_ID, actor, presignInput())).rejects.toBeInstanceOf(
      PhotosDisabledException,
    )
  })

  it('404 si la mission est introuvable', async () => {
    const { service } = buildHarness({ mission: null })
    await expect(service.presign(MISSION_ID, actor, presignInput())).rejects.toBeInstanceOf(
      MissionNotFoundForPhotoException,
    )
  })

  it('403 si l\'acteur PRESTATAIRE n\'est pas assigné à la mission', async () => {
    const { service } = buildHarness({ mission: buildMission({ prestataireId: OTHER_PRESTA_ID }) })
    await expect(service.presign(MISSION_ID, actor, presignInput())).rejects.toBeInstanceOf(
      PhotoForbiddenException,
    )
  })

  it('403 si l\'acteur a un rôle CLIENT (refus strict, MVP)', async () => {
    const { service } = buildHarness()
    await expect(
      service.presign(MISSION_ID, { id: PRESTA_ID, role: 'CLIENT' as Role }, presignInput()),
    ).rejects.toBeInstanceOf(PhotoForbiddenException)
  })

  it('ADMIN bypass : autorisé même non assigné', async () => {
    const { service } = buildHarness({ mission: buildMission({ prestataireId: OTHER_PRESTA_ID }) })
    const res = await service.presign(MISSION_ID, adminActor, presignInput())
    expect(res.photoUploadSessionId).toBe(SESSION_ID)
    expect(res.sessionToken).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('happy path : crée la session + retourne signature + audit MissionEvent', async () => {
    const { service, photosRepo, cloudinary } = buildHarness()
    const res = await service.presign(MISSION_ID, actor, presignInput())
    expect(res.photoUploadSessionId).toBe(SESSION_ID)
    expect(res.sessionToken).toHaveLength(64)
    expect(res.uploadUrl).toContain('api.cloudinary.com')
    expect(res.cloudinaryParams.public_id).toBe('unit/missions/m1/before/c1/original')
    expect(res.cloudinaryParams.signature).toMatch(/^[a-f0-9]+$/u)
    expect(res.maxBytes).toBe(10 * 1024 * 1024)
    expect(res.allowedMimeTypes).toContain('image/jpeg')
    expect(photosRepo.createSession).toHaveBeenCalledTimes(1)
    expect(cloudinary.signUploadParams).toHaveBeenCalledTimes(1)
  })

  it('refuse missionId URL ≠ missionId body (anti-cross-mission)', async () => {
    const { service } = buildHarness()
    await expect(
      service.presign(MISSION_ID, actor, presignInput({ missionId: '00000000-0000-4000-8000-aaaaaaaaaaaa' })),
    ).rejects.toBeInstanceOf(PhotoUploadSessionMissionMismatchException)
  })
})

describe('PhotosService.confirm (PRD-003 Ticket 3.3)', () => {
  it('503 PHOTOS_DISABLED si FF off', async () => {
    const { service } = buildHarness({ photosEnabled: false })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotosDisabledException,
    )
  })

  it('404 si la mission est introuvable', async () => {
    const { service } = buildHarness({ mission: null })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      MissionNotFoundForPhotoException,
    )
  })

  it('403 si non assigné à la mission', async () => {
    const { service } = buildHarness({ mission: buildMission({ prestataireId: OTHER_PRESTA_ID }) })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoForbiddenException,
    )
  })

  it('409 si sessionToken ne match aucun digest connu (tokenDigest lookup miss)', async () => {
    const { service } = buildHarness({ session: null })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoUploadSessionAlreadyConsumedException,
    )
  })

  it('409 si photoUploadSessionId ne match pas l\'ID associé au token', async () => {
    const { service } = buildHarness({
      session: buildSession({ id: '00000000-0000-4000-8000-000000000099' }),
    })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoUploadSessionAlreadyConsumedException,
    )
  })

  it('409 si session.missionId ≠ URL missionId (anti cross-mission)', async () => {
    const { service } = buildHarness({
      session: buildSession({ missionId: '00000000-0000-4000-8000-000000000999' }),
    })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoUploadSessionMissionMismatchException,
    )
  })

  it('403 si la session appartient à un autre uploader (anti session-stealing)', async () => {
    const { service } = buildHarness({
      session: buildSession({ uploaderUserId: OTHER_PRESTA_ID }),
      mission: buildMission({ prestataireId: OTHER_PRESTA_ID }),
    })
    await expect(service.confirm(MISSION_ID, otherActor, confirmInput())).resolves.toBeDefined()
    // Cas symétrique : un autre prestataire avec son JWT essaie de re-jouer la session
    const { service: svc2 } = buildHarness({
      session: buildSession({ uploaderUserId: OTHER_PRESTA_ID }),
      mission: buildMission({ prestataireId: PRESTA_ID }),
    })
    await expect(svc2.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoForbiddenException,
    )
  })

  it('409 si captureClientUuid du body ≠ celui scellé dans la session', async () => {
    const { service } = buildHarness({ session: buildSession() })
    await expect(
      service.confirm(
        MISSION_ID,
        actor,
        confirmInput({ captureClientUuid: '00000000-0000-4000-8000-000000bb0bb0' }),
      ),
    ).rejects.toBeInstanceOf(PhotoCaptureUuidMismatchException)
  })

  it('409 si cloudinaryPublicId body ≠ celui scellé dans la session (anti-spoof)', async () => {
    const { service } = buildHarness({ session: buildSession() })
    await expect(
      service.confirm(MISSION_ID, actor, confirmInput({ cloudinaryPublicId: 'forged/public/id' })),
    ).rejects.toBeInstanceOf(PhotoCloudinaryPublicIdMismatchException)
  })

  it('410 PHOTO_UPLOAD_SESSION_EXPIRED si session.expiresAt < now', async () => {
    const expiredSession = buildSession({ expiresAt: new Date(Date.now() - 60_000) })
    const { service } = buildHarness({ session: expiredSession })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoUploadSessionExpiredException,
    )
  })

  it('409 si session déjà consommée et aucune Photo en DB (session sealed sans confirm complet)', async () => {
    const consumedSession = buildSession({ consumedAt: new Date() })
    const { service } = buildHarness({ session: consumedSession, existingPhoto: null })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoUploadSessionAlreadyConsumedException,
    )
  })

  it('422 PHOTO_INVALID_STATE si l\'asset Cloudinary n\'existe pas (anti-spoof côté Cloudinary)', async () => {
    const { service } = buildHarness({ session: buildSession(), resource: 'NOT_FOUND' })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoCloudinaryAssetMissingException,
    )
  })

  it('400 PHOTO_MAX_BYTES_EXCEEDED si bytes Cloudinary > session.maxBytes (CTO merge)', async () => {
    const { service } = buildHarness({
      session: buildSession({ maxBytes: 100_000 }),
    })
    await expect(service.confirm(MISSION_ID, actor, confirmInput())).rejects.toBeInstanceOf(
      PhotoMaxBytesExceededException,
    )
  })

  it('happy path : crée Photo + audit + idempotent: false', async () => {
    const { service, photosRepo } = buildHarness({ session: buildSession() })
    const res = await service.confirm(MISSION_ID, actor, confirmInput())
    expect(res.idempotent).toBe(false)
    expect(res.photoId).toBe(PHOTO_ID)
    expect(res.missionId).toBe(MISSION_ID)
    expect(res.phase).toBe('BEFORE')
    expect(res.variant).toBe('ORIGINAL')
    expect(photosRepo.markSessionConsumedTx).toHaveBeenCalledTimes(1)
    expect(photosRepo.createPhotoTx).toHaveBeenCalledTimes(1)
  })

  it('replay : Photo existante (missionId, captureClientUuid, variant) → 201 idempotent: true', async () => {
    const existingPhoto = buildPhoto()
    const { service, photosRepo } = buildHarness({
      session: buildSession(),
      existingPhoto,
    })
    const res = await service.confirm(MISSION_ID, actor, confirmInput())
    expect(res.idempotent).toBe(true)
    expect(res.photoId).toBe(existingPhoto.id)
    expect(photosRepo.markSessionConsumedTx).not.toHaveBeenCalled()
    expect(photosRepo.createPhotoTx).not.toHaveBeenCalled()
  })
})
