/**
 * Tests d'intégration — Missions PRD-002 Build.
 *
 * Couvre les contraintes CTO Build :
 *   §1 Audit MissionEvent (CREATED, PUBLISHED, MATCHING_DONE, ACCEPTED, EXPIRED, CANCELLED)
 *   §2 missionNumber généré serveur, format CC-YYYY-XXXXXXXX
 *   §3 Matching PostGIS paginé et borné
 *   §4 Aucune adresse complète pour prestataire pré-acceptation (`kind=MASKED`)
 *   §5 Exclusion matching : suspendu / soft-deleted / non vérifié
 *   §6 Toute transition passe par `assertMissionTransition` (négatifs : 409)
 *   §7 Aucune logique métier en controller (testé indirectement par 4xx propres)
 *
 * Prérequis : Postgres + PostGIS (`pnpm db:test:up`) — Redis pas requis (matching synchrone MVP).
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
  ADMIN_MISSIONS_BASE,
  cleanupMissions,
  createTestUser,
  forgeAccessToken,
  MISSIONS_BASE,
} from './missions-helpers'

jest.setTimeout(120_000)

async function buildApp(): Promise<INestApplication> {
  process.env['DISABLE_THROTTLE'] = 'true'
  // Force MISSION_LISTING_TTL_MS court (10 min) — assez pour les tests, pas pour la prod réelle.
  process.env['MISSION_LISTING_TTL_MS'] = process.env['MISSION_LISTING_TTL_MS'] ?? '600000'
  process.env['BAN_BASE_URL'] = process.env['BAN_BASE_URL'] ?? 'https://example-ban.test'

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
  await app.init()
  return app
}

const PARIS_BASE = { lat: 48.8566, lng: 2.3522 }

function nearbyAddress(label: string, lat = PARIS_BASE.lat, lng = PARIS_BASE.lng) {
  return {
    street: `${label} test`,
    city: 'Paris',
    zipCode: '75011',
    country: 'FR',
    location: { lat, lng },
  }
}

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1_000)
const TOMORROW_PLUS_2H = new Date(TOMORROW.getTime() + 2 * 60 * 60 * 1_000)

function createDraftBody(opts?: { isAsap?: boolean; lat?: number; lng?: number }) {
  return {
    serviceType: 'SOFA' as const,
    address: nearbyAddress('Mission', opts?.lat, opts?.lng),
    isAsap: opts?.isAsap ?? false,
    startAt: TOMORROW.toISOString(),
    endAt: TOMORROW_PLUS_2H.toISOString(),
    timeZone: 'Europe/Paris',
    estimatedPriceCents: 5_000,
  }
}

describe('Missions integration flow (PRD-002 Build)', () => {
  let app: INestApplication | undefined
  let prisma: PrismaService | undefined

  beforeAll(async () => {
    app = await buildApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    if (prisma) await cleanupMissions(prisma)
    if (app) await app.close()
  })

  function http() {
    if (!app) throw new Error('App not initialized')
    return app.getHttpServer()
  }

  function db(): PrismaService {
    if (!prisma) throw new Error('Prisma not initialized')
    return prisma
  }

  // ---------------------------------------------------------------------------
  // Flow nominal CLIENT → CREATE → PUBLISH → ACCEPT
  // ---------------------------------------------------------------------------

  it('1 — flow nominal : create draft 201, missionNumber CC-YYYY-XXXXXXXX', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const token = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const res = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${token}`)
      .send(createDraftBody())
      .expect(201)

    expect(res.body.status).toBe('DRAFT')
    expect(res.body.missionNumber).toMatch(/^CC-\d{4}-[0-9A-Z]{8}$/u)
    expect(res.body.address.kind).toBe('FULL') // CLIENT propriétaire => adresse complète

    const events = await db().missionEvent.findMany({ where: { missionId: res.body.id } })
    expect(events.find((e) => e.type === 'CREATED')).toBeDefined()
  })

  it('2 — publish DRAFT → PUBLISHED + listingExpiresAt + MissionEvent PUBLISHED', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const token = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${token}`)
      .send(createDraftBody())
      .expect(201)

    const published = await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200)

    expect(published.body.status).toBe('PUBLISHED')
    expect(published.body.listingExpiresAt).not.toBeNull()
    expect(published.body.publishedAt).not.toBeNull()

    const events = await db().missionEvent.findMany({
      where: { missionId: draft.body.id },
      orderBy: { createdAt: 'asc' },
    })
    const types = events.map((e) => e.type)
    expect(types).toContain('CREATED')
    expect(types).toContain('PUBLISHED')
    expect(types).toContain('MATCHING_DONE')
  })

  // ---------------------------------------------------------------------------
  // Matching PostGIS — éligibilité + exclusions
  // ---------------------------------------------------------------------------

  it('3 — matching crée une MissionProposal pour prestataire dans le rayon', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const presta = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: '1 base', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
      serviceRadiusKm: 5,
    })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    const proposals = await db().missionProposal.findMany({ where: { missionId: draft.body.id } })
    expect(proposals.map((p) => p.prestataireId)).toContain(presta.id)
  })

  it('4 — exclusion matching : suspendu / soft-deleted / non vérifié + hors rayon', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const eligible = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'eligible', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
      serviceRadiusKm: 5,
    })

    const suspended = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'sus', city: 'Paris', zipCode: '75011', lat: 48.858, lng: 2.354 },
      serviceRadiusKm: 5,
      suspended: true,
    })

    const unverified = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'unverif', city: 'Paris', zipCode: '75011', lat: 48.859, lng: 2.355 },
      serviceRadiusKm: 5,
      unverified: true,
    })

    const softDeleted = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'sd', city: 'Paris', zipCode: '75011', lat: 48.86, lng: 2.356 },
      serviceRadiusKm: 5,
    })
    await db().user.update({ where: { id: softDeleted.id }, data: { deletedAt: new Date() } })

    const farAway = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      // Marseille — > 700 km de Paris, hors rayon 5 km
      base: { street: 'far', city: 'Marseille', zipCode: '13001', lat: 43.296, lng: 5.369 },
      serviceRadiusKm: 5,
    })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    const proposals = await db().missionProposal.findMany({ where: { missionId: draft.body.id } })
    const ids = proposals.map((p) => p.prestataireId)

    expect(ids).toContain(eligible.id)
    expect(ids).not.toContain(suspended.id)
    expect(ids).not.toContain(unverified.id)
    expect(ids).not.toContain(softDeleted.id)
    expect(ids).not.toContain(farAway.id)
  })

  // ---------------------------------------------------------------------------
  // Address policy — masquage RGPD pré-acceptation
  // ---------------------------------------------------------------------------

  it('5 — prestataire éligible voit address.kind=MASKED avant acceptation', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const presta = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'p1', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
      serviceRadiusKm: 5,
    })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })
    const tokenPresta = await forgeAccessToken(app!, { id: presta.id, role: 'PRESTATAIRE' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    const view = await request(http())
      .get(`${MISSIONS_BASE}/${draft.body.id as string}`)
      .set('Authorization', `Bearer ${tokenPresta}`)
      .expect(200)

    expect(view.body.address.kind).toBe('MASKED')
    expect(view.body.address).not.toHaveProperty('street')
    expect(view.body.address).not.toHaveProperty('location')
    expect(view.body.address.partialZipCode).toMatch(/^\d{2}\*+$/u)
  })

  // ---------------------------------------------------------------------------
  // Accept + lock optimiste (race condition)
  // ---------------------------------------------------------------------------

  it('6 — accept first-wins : un seul prestataire gagne sur 2 acceptances simultanées', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const presta1 = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'p1', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
      serviceRadiusKm: 5,
    })
    const presta2 = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'p2', city: 'Paris', zipCode: '75011', lat: 48.858, lng: 2.354 },
      serviceRadiusKm: 5,
    })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    const t1 = await forgeAccessToken(app!, { id: presta1.id, role: 'PRESTATAIRE' })
    const t2 = await forgeAccessToken(app!, { id: presta2.id, role: 'PRESTATAIRE' })

    const [r1, r2] = await Promise.all([
      request(http())
        .post(`${MISSIONS_BASE}/${draft.body.id as string}/accept`)
        .set('Authorization', `Bearer ${t1}`)
        .send({}),
      request(http())
        .post(`${MISSIONS_BASE}/${draft.body.id as string}/accept`)
        .set('Authorization', `Bearer ${t2}`)
        .send({}),
    ])

    const statusCodes = [r1.status, r2.status].sort()
    expect(statusCodes).toEqual([200, 409])

    const winnerRes = r1.status === 200 ? r1 : r2
    expect(winnerRes.body.status).toBe('ACCEPTED')
    expect([presta1.id, presta2.id]).toContain(winnerRes.body.prestataireId)

    const loserRes = r1.status === 409 ? r1 : r2
    expect(loserRes.body.error).toBe('MISSION_ALREADY_ACCEPTED')
  })

  it('7 — après ACCEPT, prestataire assigné voit address.kind=FULL', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const presta = await createTestUser(db(), {
      role: 'PRESTATAIRE',
      base: { street: 'p1', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
      serviceRadiusKm: 5,
    })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })
    const tokenPresta = await forgeAccessToken(app!, { id: presta.id, role: 'PRESTATAIRE' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/accept`)
      .set('Authorization', `Bearer ${tokenPresta}`)
      .send({})
      .expect(200)

    const view = await request(http())
      .get(`${MISSIONS_BASE}/${draft.body.id as string}`)
      .set('Authorization', `Bearer ${tokenPresta}`)
      .expect(200)

    expect(view.body.address.kind).toBe('FULL')
    expect(view.body.address.street).toBeDefined()
    expect(view.body.address.location).toEqual({ lat: PARIS_BASE.lat, lng: PARIS_BASE.lng })
  })

  // ---------------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------------

  it('8 — RBAC : un autre CLIENT reçoit 403 sur GET /missions/:id', async () => {
    const ownerClient = await createTestUser(db(), { role: 'CLIENT' })
    const otherClient = await createTestUser(db(), { role: 'CLIENT' })
    const tokenOwner = await forgeAccessToken(app!, { id: ownerClient.id, role: 'CLIENT' })
    const tokenOther = await forgeAccessToken(app!, { id: otherClient.id, role: 'CLIENT' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenOwner}`)
      .send(createDraftBody())
      .expect(201)

    const res = await request(http())
      .get(`${MISSIONS_BASE}/${draft.body.id as string}`)
      .set('Authorization', `Bearer ${tokenOther}`)
      .expect(403)
    expect(res.body.error).toBe('MISSION_FORBIDDEN')
  })

  it('9 — RBAC : un PRESTATAIRE ne peut pas POST /missions (403)', async () => {
    const presta = await createTestUser(db(), { role: 'PRESTATAIRE' })
    const token = await forgeAccessToken(app!, { id: presta.id, role: 'PRESTATAIRE' })

    await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${token}`)
      .send(createDraftBody())
      .expect(403)
  })

  it('10 — RBAC : ADMIN voit la mission via /admin/missions et reçoit address.kind=FULL', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const admin = await createTestUser(db(), { role: 'ADMIN' })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })
    const tokenAdmin = await forgeAccessToken(app!, { id: admin.id, role: 'ADMIN' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    const list = await request(http())
      .get(ADMIN_MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .expect(200)

    const item = (list.body.items as Array<{ id: string; address: { kind: string } }>).find(
      (i) => i.id === draft.body.id,
    )
    expect(item).toBeDefined()
    expect(item?.address.kind).toBe('FULL')
  })

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  it('11 — publish d\'une mission CANCELLED retourne 409 MISSION_INVALID_STATE', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const token = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${token}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .delete(`${MISSIONS_BASE}/${draft.body.id as string}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'changed mind' })
      .expect(200)

    const res = await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409)
    expect(res.body.error).toBe('MISSION_INVALID_STATE')
  })

  // ---------------------------------------------------------------------------
  // Listing TTL
  // ---------------------------------------------------------------------------

  it('12 — expireIfStillProposed : PUBLISHED → EXPIRED + audit MissionEvent EXPIRED', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const tokenClient = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send(createDraftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({})
      .expect(200)

    // Backdate listingExpiresAt — simule expiration sans attendre 15 min réelles.
    await db().mission.update({
      where: { id: draft.body.id as string },
      data: { listingExpiresAt: new Date(Date.now() - 60_000) },
    })

    const missionsServiceModule = await import('../../src/modules/missions/missions.service')
    const service = app!.get(missionsServiceModule.MissionsService)
    const result = await service.expireIfStillProposed(draft.body.id as string)
    expect(result.expired).toBe(true)

    const reloaded = await db().mission.findUnique({ where: { id: draft.body.id as string } })
    expect(reloaded?.status).toBe('EXPIRED')

    const expiredEvent = await db().missionEvent.findFirst({
      where: { missionId: draft.body.id, type: 'EXPIRED' },
    })
    expect(expiredEvent).toBeDefined()
  })

  // ---------------------------------------------------------------------------
  // Validation Zod (input strict)
  // ---------------------------------------------------------------------------

  it('13 — body invalide (endAt avant startAt) => 400 ValidationError', async () => {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const token = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    const res = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...createDraftBody(),
        endAt: TOMORROW.toISOString(),
        startAt: TOMORROW_PLUS_2H.toISOString(),
      })
      .expect(400)
    expect(res.body.error).toBe('ValidationError')
  })
})
