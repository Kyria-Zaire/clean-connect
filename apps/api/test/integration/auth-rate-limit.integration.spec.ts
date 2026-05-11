/**
 * Vérifie que le `ThrottlerGuard` global + les décorateurs `@Throttle` per-route
 * sont bien appliqués sur les endpoints sensibles (signup / login).
 *
 * Sépare du `auth-flow.integration.spec.ts` qui désactive le guard pour pouvoir
 * tester les invariants métier sans 429 parasites. Ici on lève uniquement le
 * scénario rate-limit pur. PRD-001 §4.3, AC-2.5.
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'

import { randomTestEmail, STRONG_PASSWORD } from './auth-integration-helpers'

jest.setTimeout(120_000)

const BASE = '/api/v1/auth'

async function buildApp(): Promise<INestApplication> {
  process.env['JWT_ACCESS_SECRET'] =
    process.env['JWT_ACCESS_SECRET'] ??
    'ci_jwt_access_secret_min_48_chars_______________________________________'
  process.env['JWT_REFRESH_SECRET'] =
    process.env['JWT_REFRESH_SECRET'] ??
    'ci_refresh_secret_min_48_chars___________________________________________'
  process.env['THROTTLE_LIMIT'] = '10000'
  process.env['THROTTLE_TTL_SECONDS'] = '60'
  // Test dédié rate-limit : on RÉ-active le throttler (suite isolée Jest).
  process.env['DISABLE_THROTTLE'] = 'false'

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

describe('Auth rate limit (PRD-001 AC-2.5)', () => {
  let app: INestApplication | undefined
  let prisma: PrismaService | undefined

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.refreshToken.deleteMany({
        where: { user: { email: { contains: '@cc-test.fr' } } },
      })
      await prisma.user.deleteMany({ where: { email: { contains: '@cc-test.fr' } } })
    }
    if (app) await app.close()
  })

  function getHttpServer() {
    if (!app) throw new Error('App non initialisée')
    return app.getHttpServer()
  }

  it('signup : 6e requête depuis la même IP => 429 (limite 5/min)', async () => {
    const server = getHttpServer()
    let lastStatus = 0
    for (let i = 0; i < 6; i += 1) {
      const res = await request(server)
        .post(`${BASE}/signup`)
        .send({
          email: randomTestEmail(),
          password: STRONG_PASSWORD,
          role: 'CLIENT',
          firstName: 'R',
          lastName: 'L',
        })
      lastStatus = res.status
      if (i < 5) {
        expect([201, 409, 400]).toContain(res.status)
      }
    }
    expect(lastStatus).toBe(429)
  })
})
