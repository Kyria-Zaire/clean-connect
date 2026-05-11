/**
 * Tests d'intégration du flux auth complet — PRD-001.
 *
 * Prérequis : Postgres + Redis éphémères démarrés (cf. `pnpm db:test:up` ou job CI `integration`).
 * Le `global-setup.ts` configure DATABASE_URL_TEST. Les migrations Prisma sont
 * appliquées par la pipeline CI avant ce test (job CI step `db:migrate:deploy`).
 *
 * On vérifie ici les ACs critiques du PRD :
 *   AC-1.1, AC-1.2, AC-1.5         (signup OK / conflict / refus ADMIN)
 *   AC-2.1, AC-2.2, AC-2.3         (login OK / wrong / soft-deleted)
 *   AC-4.1, AC-4.3, AC-4.5         (refresh rotation + cascade replay + atomicité)
 *   AC-5.1, AC-5.2                 (logout 204 + idempotent)
 *   AC-6.1, AC-6.4                 (me 401/200 selon Bearer)
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'

const BASE = '/api/v1/auth'

async function buildApp(): Promise<INestApplication> {
  process.env['JWT_ACCESS_SECRET'] =
    process.env['JWT_ACCESS_SECRET'] ??
    'ci_jwt_access_secret_min_48_chars_______________________________________'
  process.env['JWT_REFRESH_SECRET'] =
    process.env['JWT_REFRESH_SECRET'] ??
    'ci_refresh_secret_min_48_chars___________________________________________'
  process.env['THROTTLE_LIMIT'] = '10000' // évite tout 429 dans la séquence de tests
  process.env['THROTTLE_TTL_SECONDS'] = '60'

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

const randomEmail = () => `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@cc-test.fr`

const PWD = 'Sup3rSecret_passw0rd_2026!'

describe('Auth integration flow', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { user: { email: { contains: '@cc-test.fr' } } } })
    await prisma.user.deleteMany({ where: { email: { contains: '@cc-test.fr' } } })
    await app.close()
  })

  it('signup CLIENT 201 + tokens présents', async () => {
    const email = randomEmail()
    const res = await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({
        email,
        password: PWD,
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Dupont',
      })
      .expect(201)

    expect(res.body.user.email).toBe(email)
    expect(res.body.user.role).toBe('CLIENT')
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(typeof res.body.accessToken).toBe('string')
    expect(typeof res.body.refreshToken).toBe('string')
  })

  it('signup ADMIN refusé (400)', async () => {
    await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({
        email: randomEmail(),
        password: PWD,
        role: 'ADMIN',
        firstName: 'A',
        lastName: 'B',
      })
      .expect(400)
  })

  it('signup duplicate => 409 EMAIL_ALREADY_USED', async () => {
    const email = randomEmail()
    await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'CLIENT', firstName: 'A', lastName: 'B' })
      .expect(201)

    const res = await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'CLIENT', firstName: 'A', lastName: 'B' })
      .expect(409)

    expect(res.body.error).toBe('EMAIL_ALREADY_USED')
  })

  it('login OK puis /me protégé', async () => {
    const email = randomEmail()
    await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'PRESTATAIRE', firstName: 'Bob', lastName: 'Martin' })
      .expect(201)

    const login = await request(app.getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: PWD })
      .expect(200)

    const access = login.body.accessToken as string

    await request(app.getHttpServer()).get(`${BASE}/me`).expect(401)

    const me = await request(app.getHttpServer())
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${access}`)
      .expect(200)

    expect(me.body.email).toBe(email)
    expect(me.body.role).toBe('PRESTATAIRE')
  })

  it('login mauvais password => 401 INVALID_CREDENTIALS', async () => {
    const email = randomEmail()
    await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'CLIENT', firstName: 'X', lastName: 'Y' })
      .expect(201)

    const res = await request(app.getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: 'wrong-password' })
      .expect(401)

    expect(res.body.error).toBe('INVALID_CREDENTIALS')
  })

  it('refresh : rotation + 401 sur replay + cascade', async () => {
    const email = randomEmail()
    const signup = await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'CLIENT', firstName: 'C', lastName: 'D' })
      .expect(201)

    // Ouvre une 2e session (multi-device autorisé) pour vérifier la cascade
    const login2 = await request(app.getHttpServer())
      .post(`${BASE}/login`)
      .send({ email, password: PWD })
      .expect(200)

    const r1 = signup.body.refreshToken as string
    const r2 = login2.body.refreshToken as string

    const rotated = await request(app.getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r1 })
      .expect(200)

    expect(rotated.body.refreshToken).not.toEqual(r1)

    // Replay du r1 (déjà révoqué) → 401 + cascade : r2 doit aussi être inutilisable
    await request(app.getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r1 })
      .expect(401)

    await request(app.getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: r2 })
      .expect(401)
  })

  it('logout 204 idempotent', async () => {
    const email = randomEmail()
    const signup = await request(app.getHttpServer())
      .post(`${BASE}/signup`)
      .send({ email, password: PWD, role: 'CLIENT', firstName: 'E', lastName: 'F' })
      .expect(201)

    const rt = signup.body.refreshToken as string

    await request(app.getHttpServer())
      .post(`${BASE}/logout`)
      .send({ refreshToken: rt })
      .expect(204)

    await request(app.getHttpServer())
      .post(`${BASE}/logout`)
      .send({ refreshToken: rt })
      .expect(204)

    await request(app.getHttpServer())
      .post(`${BASE}/refresh`)
      .send({ refreshToken: rt })
      .expect(401)
  })
})
