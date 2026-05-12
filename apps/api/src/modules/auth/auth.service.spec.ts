/**
 * Tests unitaires AuthService.
 * Prisma est entièrement mocké — les flux DB sont couverts par les tests
 * d'intégration (cf. `test/integration/auth-flow.integration.spec.ts`).
 */

import { ConflictException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Prisma, RefreshToken, User } from '@prisma/client'

import { AUTH_ERROR_CODES } from './auth.constants'
import { AuthService } from './auth.service'
import { PasswordService } from './services/password.service'
import { TokenService } from './services/token.service'

interface PrismaMock {
  user: {
    findUnique: jest.Mock
    create: jest.Mock
  }
  refreshToken: {
    findUnique: jest.Mock
    create: jest.Mock
    update: jest.Mock
    updateMany: jest.Mock
  }
  $transaction: jest.Mock<Promise<unknown[]>, [Prisma.PrismaPromise<unknown>[]]>
}

const buildPrismaMock = (): PrismaMock => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  refreshToken: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  $transaction: jest.fn().mockResolvedValue([]),
})

const baseUser = (): User => ({
  id: 'user-1',
  email: 'alice@example.com',
  passwordHash: '$2b$10$hash',
  firstName: 'Alice',
  lastName: 'Dupont',
  role: 'CLIENT',
  stripeCustomerId: null,
  stripeAccountId: null,
  addressId: null,
  serviceRadiusKm: 15,
  deletedAt: null,
  createdAt: new Date('2026-05-12T10:00:00Z'),
  updatedAt: new Date('2026-05-12T10:00:00Z'),
})

beforeAll(() => {
  process.env['JWT_ACCESS_SECRET'] = 'test_access_secret_min_48_chars_abcdef_abcdef_abcdef_abcdef_xyz'
  process.env['JWT_REFRESH_SECRET'] = 'test_refresh_secret_min_48_chars_xyz_xyz_xyz_xyz_xyz_xyz_xyz_abc'
  process.env['JWT_ACCESS_EXPIRES_IN'] = '15m'
  process.env['JWT_REFRESH_EXPIRES_IN'] = '30d'
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5433/cleanconnect_test'
  process.env['REDIS_URL'] = 'redis://localhost:6380'
  process.env['CORS_ORIGINS'] = 'http://localhost:5173'
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_xyz'
  process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_xyz'
  process.env['NODE_ENV'] = 'development'
  process.env['APP_ENV'] = 'development'
})

const build = () => {
  const prisma = buildPrismaMock()
  const tokens = new TokenService(new JwtService({}))
  const passwords = new PasswordService()
  // Hash bcrypt évité dans les tests unitaires pour rester rapide
  jest.spyOn(passwords, 'hash').mockResolvedValue('$2b$10$mockhash')
  jest.spyOn(passwords, 'verify').mockResolvedValue(true)
  const service = new AuthService(prisma as never, passwords, tokens)
  return { prisma, tokens, passwords, service }
}

describe('AuthService.signUp', () => {
  it('crée le user + persiste le hash du refresh et renvoie la paire de tokens', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.user.create.mockResolvedValue(baseUser())
    prisma.refreshToken.create.mockResolvedValue({} as RefreshToken)

    const session = await service.signUp({
      email: 'Alice@Example.com',
      password: 'Sup3rSecret_passw0rd!',
      role: 'CLIENT',
      firstName: 'Alice',
      lastName: 'Dupont',
    })

    expect(session.user.email).toBe('alice@example.com')
    expect(session.user.role).toBe('CLIENT')
    expect(session.accessToken.length).toBeGreaterThan(20)
    expect(session.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/u)

    const refreshCreateArgs = prisma.refreshToken.create.mock.calls[0]?.[0] as
      | { data: { tokenHash: string } }
      | undefined
    expect(refreshCreateArgs?.data.tokenHash).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('renvoie 409 EMAIL_ALREADY_USED si l\'email existe déjà', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' })

    await expect(
      service.signUp({
        email: 'alice@example.com',
        password: 'Sup3rSecret_passw0rd!',
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Dupont',
      }),
    ).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.EMAIL_ALREADY_USED },
    })
  })
})

describe('AuthService.login', () => {
  it('renvoie une session pour des credentials valides', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue(baseUser())
    prisma.refreshToken.create.mockResolvedValue({} as RefreshToken)

    const session = await service.login({
      email: 'alice@example.com',
      password: 'Sup3rSecret_passw0rd!',
    })

    expect(session.user.id).toBe('user-1')
    expect(session.accessToken).toBeDefined()
  })

  it('renvoie 401 INVALID_CREDENTIALS si user inconnu', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue(null)

    await expect(
      service.login({ email: 'ghost@example.com', password: 'Sup3rSecret_passw0rd!' }),
    ).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.INVALID_CREDENTIALS },
    })
  })

  it('renvoie 401 INVALID_CREDENTIALS pour un user soft-deleted', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue({ ...baseUser(), deletedAt: new Date() })

    await expect(
      service.login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' }),
    ).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.INVALID_CREDENTIALS },
    })
  })

  it('renvoie 401 INVALID_CREDENTIALS pour un mauvais mot de passe', async () => {
    const { prisma, passwords, service } = build()
    prisma.user.findUnique.mockResolvedValue(baseUser())
    jest.spyOn(passwords, 'verify').mockResolvedValue(false)

    await expect(
      service.login({ email: 'alice@example.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })
})

describe('AuthService.refresh', () => {
  it('tourne le refresh : ancien revoké + nouveau émis en transaction', async () => {
    const { prisma, tokens, service } = build()
    const stored: RefreshToken & { user: User } = {
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: 'oldhash',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
      user: baseUser(),
    }
    prisma.refreshToken.findUnique.mockResolvedValue(stored)
    jest.spyOn(tokens, 'hashRefreshToken').mockReturnValue('oldhash')

    const out = await service.refresh('opaque-refresh')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(out.accessToken).toBeDefined()
    expect(out.refreshToken).toBeDefined()
  })

  it('revoke en cascade tous les refresh actifs si reuse d\'un revoké', async () => {
    const { prisma, tokens, service } = build()
    const revoked: RefreshToken & { user: User } = {
      id: 'rt-old',
      userId: 'user-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      user: baseUser(),
    }
    prisma.refreshToken.findUnique.mockResolvedValue(revoked)
    jest.spyOn(tokens, 'hashRefreshToken').mockReturnValue('h')

    await expect(service.refresh('opaque')).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN },
    })

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    })
  })

  it('renvoie 401 si refresh inconnu', async () => {
    const { prisma, service } = build()
    prisma.refreshToken.findUnique.mockResolvedValue(null)

    await expect(service.refresh('totally-random')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('renvoie 401 si refresh expiré', async () => {
    const { prisma, tokens, service } = build()
    const expired: RefreshToken & { user: User } = {
      id: 'rt-x',
      userId: 'user-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      createdAt: new Date(),
      user: baseUser(),
    }
    prisma.refreshToken.findUnique.mockResolvedValue(expired)
    jest.spyOn(tokens, 'hashRefreshToken').mockReturnValue('h')

    await expect(service.refresh('x')).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN },
    })
  })

  it('renvoie 401 si le user lié au refresh est soft-deleted', async () => {
    const { prisma, tokens, service } = build()
    const stored: RefreshToken & { user: User } = {
      id: 'rt-del',
      userId: 'user-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
      user: { ...baseUser(), deletedAt: new Date() },
    }
    prisma.refreshToken.findUnique.mockResolvedValue(stored)
    jest.spyOn(tokens, 'hashRefreshToken').mockReturnValue('h')

    await expect(service.refresh('opaque')).rejects.toMatchObject({
      response: { error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('AuthService.logout', () => {
  it('marque le refresh comme révoqué (idempotent)', async () => {
    const { prisma, service } = build()
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 })
    await service.logout('opaque-refresh')
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ revokedAt: null }),
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    })
  })
})

describe('AuthService.getMe', () => {
  it('renvoie le profil public', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue(baseUser())
    const me = await service.getMe('user-1')
    expect(me.email).toBe('alice@example.com')
  })

  it('refuse un user soft-deleted', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue({ ...baseUser(), deletedAt: new Date() })
    await expect(service.getMe('user-1')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('refuse un user inexistant', async () => {
    const { prisma, service } = build()
    prisma.user.findUnique.mockResolvedValue(null)
    await expect(service.getMe('user-1')).rejects.toBeInstanceOf(UnauthorizedException)
  })
})

// Anti-régression : ConflictException est bien typé pour le filter
test('ConflictException expose le code structuré dans la réponse', () => {
  const e = new ConflictException({ error: AUTH_ERROR_CODES.EMAIL_ALREADY_USED })
  expect(e.getResponse()).toEqual({ error: 'EMAIL_ALREADY_USED' })
})
