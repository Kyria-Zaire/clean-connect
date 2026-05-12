/**
 * Tests unitaires — `CloudinaryClientFactory` + `CloudinaryClient`.
 *
 * Couverture :
 *  - Factory : config présente quand FF_PHOTOS_ENABLED + CLOUDINARY_URL valides.
 *  - Factory : client inactif (`isReady=false`) si CLOUDINARY_URL absent
 *    (cas où le module est chargé mais le flag est off — pas de crash boot).
 *  - signUploadParams : structure correcte + signature présente +
 *    publicId/folder = ceux fournis (anti-injection mobile).
 *  - digestToken : SHA-256 hex 64 chars déterministe.
 *  - getResource : 404 → CloudinaryResourceNotFoundError ;
 *    erreur 5xx → CloudinaryApiError.
 */

import { __resetEnvCacheForTests } from '../../../common/config/env'

import {
  CloudinaryApiError,
  CloudinaryClient,
  CloudinaryClientFactory,
  CloudinaryResourceNotFoundError,
} from './cloudinary.client'

const VALID_CLOUDINARY_URL = 'cloudinary://test_api_key_aaa:test_api_secret_bbb@test_cloud_xyz'

function resetEnv(overrides: Record<string, string | undefined> = {}): void {
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
  process.env['CLOUDINARY_URL'] = VALID_CLOUDINARY_URL
  process.env['CLOUDINARY_FOLDER_PREFIX'] = 'unit-test'
  process.env['FF_PHOTOS_ENABLED'] = 'true'
  process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] = '300'
  process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] = '300'

  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }

  __resetEnvCacheForTests()
}

describe('CloudinaryClientFactory (PRD-003 Ticket 3.3)', () => {
  beforeEach(() => {
    resetEnv()
  })

  it('builds un client ready quand FF_PHOTOS_ENABLED=true + CLOUDINARY_URL valide', () => {
    const factory = new CloudinaryClientFactory()
    const client = factory.build()
    expect(client.isReady()).toBe(true)
  })

  it('builds un client inactif (isReady=false) si CLOUDINARY_URL absent + FF off', () => {
    resetEnv({ FF_PHOTOS_ENABLED: 'false', CLOUDINARY_URL: undefined })
    const factory = new CloudinaryClientFactory()
    const client = factory.build()
    expect(client.isReady()).toBe(false)
  })

  it('crash boot si FF_PHOTOS_ENABLED=true sans CLOUDINARY_URL', () => {
    resetEnv({ FF_PHOTOS_ENABLED: 'true', CLOUDINARY_URL: undefined })
    expect(() => new CloudinaryClientFactory().build()).toThrow(/Environnement invalide/u)
  })

  it('crash boot si CLOUDINARY_URL ne respecte pas le format strict', () => {
    resetEnv({ CLOUDINARY_URL: 'https://cloudinary.com/whatever' })
    expect(() => new CloudinaryClientFactory().build()).toThrow(/Environnement invalide/u)
  })
})

describe('CloudinaryClient.signUploadParams', () => {
  beforeEach(() => {
    resetEnv()
  })

  it('retourne la structure complète signée + publicId/folder exacts', () => {
    const client = new CloudinaryClientFactory().build()
    const params = client.signUploadParams({
      folder: 'unit-test/missions/m1/before/cap1',
      publicId: 'unit-test/missions/m1/before/cap1/original',
      mimeType: 'image/jpeg',
      maxBytes: 10 * 1024 * 1024,
      timestamp: 1_700_000_000,
    })

    expect(params.cloudName).toBe('test_cloud_xyz')
    expect(params.apiKey).toBe('test_api_key_aaa')
    expect(params.publicId).toBe('unit-test/missions/m1/before/cap1/original')
    expect(params.folder).toBe('unit-test/missions/m1/before/cap1')
    expect(params.type).toBe('private')
    expect(params.timestamp).toBe(1_700_000_000)
    expect(params.signatureAlgorithm).toBe('sha1')
    expect(params.signature).toMatch(/^[a-f0-9]{40}$/u) // SHA-1 hex
    expect(params.uploadUrl).toBe(
      'https://api.cloudinary.com/v1_1/test_cloud_xyz/image/upload',
    )
    expect(params.mimeType).toBe('image/jpeg')
    expect(params.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('signature stable pour les mêmes paramètres (déterministe)', () => {
    const client = new CloudinaryClientFactory().build()
    const a = client.signUploadParams({
      folder: 'f', publicId: 'f/v', mimeType: 'image/jpeg', maxBytes: 1, timestamp: 1,
    })
    const b = client.signUploadParams({
      folder: 'f', publicId: 'f/v', mimeType: 'image/jpeg', maxBytes: 1, timestamp: 1,
    })
    expect(a.signature).toBe(b.signature)
  })

  it('signature DIFFÉRENTE si on change publicId', () => {
    const client = new CloudinaryClientFactory().build()
    const a = client.signUploadParams({
      folder: 'f', publicId: 'f/v1', mimeType: 'image/jpeg', maxBytes: 1, timestamp: 1,
    })
    const b = client.signUploadParams({
      folder: 'f', publicId: 'f/v2', mimeType: 'image/jpeg', maxBytes: 1, timestamp: 1,
    })
    expect(a.signature).not.toBe(b.signature)
  })
})

describe('CloudinaryClient.digestToken', () => {
  it('SHA-256 hex 64 chars déterministe', () => {
    const a = CloudinaryClient.digestToken('hello-world')
    const b = CloudinaryClient.digestToken('hello-world')
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('tokens différents → digests différents', () => {
    expect(CloudinaryClient.digestToken('a')).not.toBe(CloudinaryClient.digestToken('b'))
  })
})

describe('CloudinaryClient.getResource (errors)', () => {
  beforeEach(() => {
    resetEnv()
  })

  it('lève CloudinaryResourceNotFoundError sur 404 Cloudinary', async () => {
    const client = new CloudinaryClientFactory().build()
    // Stub la méthode `cloudinary.api.resource` via require
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cloudinaryV2 = (require('cloudinary') as { v2: { api: { resource: jest.Mock } } }).v2
    const original = cloudinaryV2.api.resource
    cloudinaryV2.api.resource = jest.fn().mockRejectedValue({ http_code: 404, message: 'Resource not found' })
    try {
      await expect(client.getResource('missing/publicid')).rejects.toBeInstanceOf(
        CloudinaryResourceNotFoundError,
      )
    } finally {
      cloudinaryV2.api.resource = original
    }
  })

  it('lève CloudinaryApiError sur 5xx Cloudinary', async () => {
    const client = new CloudinaryClientFactory().build()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cloudinaryV2 = (require('cloudinary') as { v2: { api: { resource: jest.Mock } } }).v2
    const original = cloudinaryV2.api.resource
    cloudinaryV2.api.resource = jest.fn().mockRejectedValue({ http_code: 502, message: 'Bad Gateway' })
    try {
      await expect(client.getResource('whatever/id')).rejects.toBeInstanceOf(CloudinaryApiError)
    } finally {
      cloudinaryV2.api.resource = original
    }
  })
})
