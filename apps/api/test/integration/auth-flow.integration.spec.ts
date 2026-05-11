/**
 * Tests d'intégration du flux auth complet — PRD-001 Ticket 1.5.
 *
 * Prérequis : Postgres + Redis (CI job `integration` ou `pnpm db:test:up` local).
 * `global-setup.ts` force `DATABASE_URL` depuis `DATABASE_URL_TEST`.
 *
 * Couverture alignée sur les 16 cas critiques CTO (signup/login/refresh/logout/me)
 * + anti-régression hashes sensibles. Chaque `it` est autonome (email unique).
 * Aucun `sleep` ; pas d'ordre d'exécution imposé entre les `it`.
 *
 * Sécurité tests : ne jamais `console.log` les tokens — utiliser uniquement des
 * assertions structurelles (`expect(res.body.error)`, `typeof …`).
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'

import {
  assertNoLeakedSecrets,
  randomTestEmail,
  STRONG_PASSWORD,
  WEAK_BLOCKLIST_PASSWORD,
} from './auth-integration-helpers'

/** Connexion Prisma au boot Nest peut dépasser 5s si Postgres est lent (CI / Docker). */
jest.setTimeout(120_000)

const BASE = '/api/v1/auth'

/**
 * Désactive le rate-limit pendant cette suite via la variable d'env
 * `DISABLE_THROTTLE=true` (consommée par `ConditionalThrottlerGuard`).
 * Les décorateurs `@Throttle` per-route (5/min signup, 10/min login,
 * 30/min refresh) restent en place et sont vérifiés indépendamment par
 * `auth-rate-limit.integration.spec.ts`. Sans ce bypass, la 6e requête
 * signup retourne 429 et masque les vraies erreurs métier.
 * Garde-fou prod : `env.ts` rejette `DISABLE_THROTTLE=true` en
 * `NODE_ENV=production` (crash boot).
 */
async function buildApp(): Promise<INestApplication> {
  process.env['JWT_ACCESS_SECRET'] =
    process.env['JWT_ACCESS_SECRET'] ??
    'ci_jwt_access_secret_min_48_chars_______________________________________'
  process.env['JWT_REFRESH_SECRET'] =
    process.env['JWT_REFRESH_SECRET'] ??
    'ci_refresh_secret_min_48_chars___________________________________________'
  process.env['THROTTLE_LIMIT'] = '10000'
  process.env['THROTTLE_TTL_SECONDS'] = '60'
  process.env['DISABLE_THROTTLE'] = 'true'

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

describe('Auth integration flow (PRD-001)', () => {
  let app: INestApplication | undefined
  let prisma: PrismaService | undefined

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  function getHttpServer() {
    if (!app) throw new Error('Integration app non démarrée (beforeAll)')
    return app.getHttpServer()
  }

  function getDb(): PrismaService {
    if (!prisma) throw new Error('Prisma non initialisé (beforeAll)')
    return prisma
  }

  afterAll(async () => {
    if (prisma) {
      await prisma.refreshToken.deleteMany({ where: { user: { email: { contains: '@cc-test.fr' } } } })
      await prisma.user.deleteMany({ where: { email: { contains: '@cc-test.fr' } } })
    }
    if (app) {
      await app.close()
    }
  })

  it('1 — signup CLIENT 201 + tokens + user public sans secrets', async () => {
    const email = randomTestEmail()
    const res = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({
        email,
        password: STRONG_PASSWORD,
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Dupont',
      })
      .expect(201)

    assertNoLeakedSecrets(res.body)
    expect(res.body.user.email).toBe(email)
    expect(res.body.user.role).toBe('CLIENT')
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(typeof res.body.accessToken).toBe('string')
    expect(typeof res.body.refreshToken).toBe('string')
  })

  it('2 — signup ADMIN public refusé (400 validation)', async () => {
    const res = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({
        email: randomTestEmail(),
        password: STRONG_PASSWORD,
        role: 'ADMIN',
        firstName: 'A',
        lastName: 'B',
      })
      .expect(400)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('ValidationError')
  })

  it('3 — signup email déjà utilisé => 409 EMAIL_ALREADY_USED', async () => {
    const email = randomTestEmail()
    await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'A', lastName: 'B' })
      .expect(201)

    const res = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'A', lastName: 'B' })
      .expect(409)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('EMAIL_ALREADY_USED')
  })

  it('4 — signup mot de passe blocklist => 400 WEAK_PASSWORD (message Zod)', async () => {
    const res = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({
        email: randomTestEmail(),
        password: WEAK_BLOCKLIST_PASSWORD,
        role: 'CLIENT',
        firstName: 'A',
        lastName: 'B',
      })
      .expect(400)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('ValidationError')
    const messages = Array.isArray(res.body.message) ? res.body.message : [String(res.body.message)]
    expect(messages.some((m: string) => m.includes('WEAK_PASSWORD'))).toBe(true)
  })

  it('5 — login OK + session sans secrets', async () => {
    const email = randomTestEmail()
    await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'PRESTATAIRE', firstName: 'Bob', lastName: 'Martin' })
      .expect(201)

    const login = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(200)

    assertNoLeakedSecrets(login.body)
    expect(login.body.user.email).toBe(email)
    expect(typeof login.body.accessToken).toBe('string')
  })

  it('6 — login mauvais mot de passe => 401 INVALID_CREDENTIALS', async () => {
    const email = randomTestEmail()
    await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'X', lastName: 'Y' })
      .expect(201)

    const res = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: 'wrong-password-xxxxxxxx' })
      .expect(401)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('INVALID_CREDENTIALS')
  })

  it('7 — login user soft-deleted => 401 INVALID_CREDENTIALS', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'S', lastName: 'D' })
      .expect(201)

    await getDb().user.update({
      where: { id: signup.body.user.id as string },
      data: { deletedAt: new Date() },
    })

    const res = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(401)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('INVALID_CREDENTIALS')
  })

  it('8 — refresh OK : ancien refresh révoqué en DB + nouveau actif', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'C', lastName: 'D' })
      .expect(201)

    const userId = signup.body.user.id as string
    const r1 = signup.body.refreshToken as string

    const rotated = await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r1 })
      .expect(200)

    assertNoLeakedSecrets(rotated.body)
    const r2 = rotated.body.refreshToken as string
    expect(r2).not.toEqual(r1)

    const rows = await getDb().refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    expect(rows.length).toBe(2)
    expect(rows[0].revokedAt).not.toBeNull()
    expect(rows[1].revokedAt).toBeNull()
  })

  it('9 — refresh token révoqué rejoué => cascade + autres refresh invalides', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'C', lastName: 'D' })
      .expect(201)

    const login2 = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(200)

    const r1 = signup.body.refreshToken as string
    const r2 = login2.body.refreshToken as string

    await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r1 })
      .expect(200)

    await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r1 })
      .expect(401)

    await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r2 })
      .expect(401)
  })

  it('10 — refresh token expiré => 401 INVALID_REFRESH_TOKEN', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'E', lastName: 'F' })
      .expect(201)

    const userId = signup.body.user.id as string
    const rt = signup.body.refreshToken as string

    await getDb().refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
    })

    const res = await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: rt })
      .expect(401)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('INVALID_REFRESH_TOKEN')
  })

  it('11 — logout 204 idempotent + refresh impossible après', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'E', lastName: 'F' })
      .expect(201)

    const rt = signup.body.refreshToken as string

    await request(getHttpServer()).post(`${BASE}/logout`).send({ refreshToken: rt }).expect(204)
    await request(getHttpServer()).post(`${BASE}/logout`).send({ refreshToken: rt }).expect(204)

    await request(getHttpServer()).post(`${BASE}/refresh`).send({ refreshToken: rt }).expect(401)
  })

  it('12 — GET /me sans Authorization => 401', async () => {
    const res = await request(getHttpServer()).get(`${BASE}/me`).expect(401)
    assertNoLeakedSecrets(res.body)
  })

  it('13 — GET /me Bearer valide => profil public sans secrets', async () => {
    const email = randomTestEmail()
    await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'G', lastName: 'H' })
      .expect(201)

    const login = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(200)

    const access = login.body.accessToken as string
    const me = await request(getHttpServer())
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${access}`)
      .expect(200)

    assertNoLeakedSecrets(me.body)
    expect(me.body.email).toBe(email)
    expect(me.body.role).toBe('CLIENT')
  })

  it('14 — GET /me user soft-deleted => 401 (JWT encore valide mais getMe bloque)', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'I', lastName: 'J' })
      .expect(201)

    const login = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(200)

    const access = login.body.accessToken as string

    await getDb().user.update({
      where: { id: signup.body.user.id as string },
      data: { deletedAt: new Date() },
    })

    const res = await request(getHttpServer())
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${access}`)
      .expect(401)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('INVALID_CREDENTIALS')
  })

  it('15 — aucune réponse auth ne contient passwordHash ni tokenHash (scan récursif)', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'K', lastName: 'L' })
      .expect(201)
    assertNoLeakedSecrets(signup.body)

    const login = await request(getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: STRONG_PASSWORD })
      .expect(200)
    assertNoLeakedSecrets(login.body)

    const rotated = await request(getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: signup.body.refreshToken as string })
      .expect(200)
    assertNoLeakedSecrets(rotated.body)

    const me = await request(getHttpServer())
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(200)
    assertNoLeakedSecrets(me.body)
  })

  it('16 — refresh avec user soft-deleted => 401 INVALID_REFRESH_TOKEN', async () => {
    const email = randomTestEmail()
    const signup = await request(getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: STRONG_PASSWORD, role: 'CLIENT', firstName: 'M', lastName: 'N' })
      .expect(201)

    const rt = signup.body.refreshToken as string

    await getDb().user.update({
      where: { id: signup.body.user.id as string },
      data: { deletedAt: new Date() },
    })

    const res = await request(getHttpServer()).post(`${BASE}/refresh`).send({ refreshToken: rt }).expect(401)

    assertNoLeakedSecrets(res.body)
    expect(res.body.error).toBe('INVALID_REFRESH_TOKEN')
  })
})

describe('auth-integration-helpers', () => {
  it('assertNoLeakedSecrets détecte passwordHash', () => {
    expect(() => assertNoLeakedSecrets({ passwordHash: 'leak' })).toThrow(/passwordHash/)
  })

  it('assertNoLeakedSecrets détecte tokenHash imbriqué', () => {
    expect(() => assertNoLeakedSecrets({ data: { tokenHash: 'x' } })).toThrow(/tokenHash/)
  })

  it('assertNoLeakedSecrets accepte un payload session typique', () => {
    expect(() =>
      assertNoLeakedSecrets({
        user: { id: 'u', email: 'a@b.fr', role: 'CLIENT', firstName: 'A', lastName: 'B', createdAt: '2026-01-01T00:00:00.000Z' },
        accessToken: 'jwt',
        refreshToken: 'opaque',
      }),
    ).not.toThrow()
  })
})
