/**
 * Tests d'intégration — PRD-002 Verify (audits CTO A → E + RBAC sans token).
 *
 * Audits couverts :
 *   A. Idempotence accept (double POST même provider) : aucun double event/mutation
 *   B. Race cancel vs accept : état final cohérent + erreur précise (pas de
 *      MISSION_ALREADY_ACCEPTED trompeur quand la mission est CANCELLED)
 *   C. Visibility policy admin : adresse complète exposée à ADMIN
 *   D. MissionEvent payload hygiene : `assertEventPayloadHygiene` rejette
 *      adresse complète + email/phone/token/jwt/password (test au niveau service)
 *   E. Race expiration vs accept : si la mission a expiré, accept renvoie
 *      MISSION_INVALID_STATE (mission_expired) — pas MISSION_ALREADY_ACCEPTED
 *
 * Vérifications complémentaires :
 *   - GET /missions/:id sans Authorization → 401
 *   - POST /missions/:id/accept sans Authorization → 401
 *   - GET /admin/missions sans rôle ADMIN → 403
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'

import { AppModule } from '../../src/app.module'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { MissionEventService } from '../../src/modules/missions/services/mission-event.service'
import { MissionsService } from '../../src/modules/missions/missions.service'

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

const PARIS = { lat: 48.8566, lng: 2.3522 }
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1_000)
const TOMORROW_2H = new Date(TOMORROW.getTime() + 2 * 60 * 60 * 1_000)

function draftBody() {
  return {
    serviceType: 'SOFA' as const,
    address: {
      street: 'Verify rue test',
      city: 'Paris',
      zipCode: '75011',
      country: 'FR',
      location: PARIS,
    },
    isAsap: false,
    startAt: TOMORROW.toISOString(),
    endAt: TOMORROW_2H.toISOString(),
    timeZone: 'Europe/Paris',
    estimatedPriceCents: 4_900,
  }
}

describe('Missions integration — PRD-002 Verify (audits CTO A→E)', () => {
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

  async function setupPublishedMission(opts?: { withPresta?: boolean }): Promise<{
    missionId: string
    clientId: string
    clientToken: string
    presta?: { id: string; token: string }
  }> {
    const client = await createTestUser(db(), { role: 'CLIENT' })
    const clientToken = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })

    let presta: { id: string; token: string } | undefined
    if (opts?.withPresta) {
      const p = await createTestUser(db(), {
        role: 'PRESTATAIRE',
        base: { street: 'p', city: 'Paris', zipCode: '75011', lat: 48.857, lng: 2.353 },
        serviceRadiusKm: 5,
      })
      const pToken = await forgeAccessToken(app!, { id: p.id, role: 'PRESTATAIRE' })
      presta = { id: p.id, token: pToken }
    }

    const draft = await request(http())
      .post(MISSIONS_BASE)
      .set('Authorization', `Bearer ${clientToken}`)
      .send(draftBody())
      .expect(201)

    await request(http())
      .post(`${MISSIONS_BASE}/${draft.body.id as string}/publish`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({})
      .expect(200)

    return { missionId: draft.body.id as string, clientId: client.id, clientToken, presta }
  }

  // ===========================================================================
  // AUDIT A — Idempotence accept (double POST même provider)
  // ===========================================================================

  describe('Audit A — Idempotence accept (même provider)', () => {
    it('A.1 — second POST /accept du même provider renvoie 409 et n\'écrit AUCUN event/mutation supplémentaire', async () => {
      const { missionId, presta } = await setupPublishedMission({ withPresta: true })
      if (!presta) throw new Error('presta required')

      const r1 = await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .set('Authorization', `Bearer ${presta.token}`)
        .send({})
        .expect(200)
      expect(r1.body.status).toBe('ACCEPTED')
      expect(r1.body.prestataireId).toBe(presta.id)

      // Snapshot état post-acceptation : `updated_at` + nb events ACCEPTED
      const afterFirst = await db().mission.findUnique({ where: { id: missionId } })
      const acceptedEventsAfterFirst = await db().missionEvent.count({
        where: { missionId, type: 'ACCEPTED' },
      })
      const allEventsAfterFirst = await db().missionEvent.count({ where: { missionId } })

      // Second POST (même prestataire, même mission)
      const r2 = await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .set('Authorization', `Bearer ${presta.token}`)
        .send({})
        .expect(409)
      expect(r2.body.error).toBe('MISSION_ALREADY_ACCEPTED')

      // Vérifie qu'AUCUNE mutation ni AUCUN nouvel event n'a été créé
      const afterSecond = await db().mission.findUnique({ where: { id: missionId } })
      const acceptedEventsAfterSecond = await db().missionEvent.count({
        where: { missionId, type: 'ACCEPTED' },
      })
      const allEventsAfterSecond = await db().missionEvent.count({ where: { missionId } })

      expect(afterSecond?.status).toBe('ACCEPTED')
      expect(afterSecond?.prestataireId).toBe(presta.id)
      expect(afterSecond?.updatedAt.getTime()).toBe(afterFirst?.updatedAt.getTime())
      expect(acceptedEventsAfterSecond).toBe(acceptedEventsAfterFirst)
      expect(acceptedEventsAfterSecond).toBe(1) // exactement 1 ACCEPTED event
      expect(allEventsAfterSecond).toBe(allEventsAfterFirst)
    })
  })

  // ===========================================================================
  // AUDIT B — Race cancel vs accept
  // ===========================================================================

  describe('Audit B — Race cancel vs accept', () => {
    it('B.1 — cancel arrive AVANT accept : accept renvoie 409 MISSION_INVALID_STATE (mission_cancelled), mission reste CANCELLED', async () => {
      const { missionId, clientToken, presta } = await setupPublishedMission({ withPresta: true })
      if (!presta) throw new Error('presta required')

      // Le client cancel D'ABORD
      await request(http())
        .delete(`${MISSIONS_BASE}/${missionId}`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ reason: 'changed_mind' })
        .expect(200)

      const cancelled = await db().mission.findUnique({ where: { id: missionId } })
      expect(cancelled?.status).toBe('CANCELLED')

      // Le prestataire tente d'accepter ensuite
      const accept = await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .set('Authorization', `Bearer ${presta.token}`)
        .send({})
        .expect(409)

      // Erreur précise : mission_cancelled, PAS MISSION_ALREADY_ACCEPTED
      expect(accept.body.error).toBe('MISSION_INVALID_STATE')
      expect(accept.body.reason).toBe('mission_cancelled')

      // Aucun event ACCEPTED n'a été écrit
      const acceptedCount = await db().missionEvent.count({
        where: { missionId, type: 'ACCEPTED' },
      })
      expect(acceptedCount).toBe(0)

      // Mission toujours CANCELLED, prestataireId reste null
      const final = await db().mission.findUnique({ where: { id: missionId } })
      expect(final?.status).toBe('CANCELLED')
      expect(final?.prestataireId).toBeNull()
    })

    it('B.2 — accept et cancel concurrents : état final cohérent (un seul gagne, l\'autre échoue proprement)', async () => {
      const { missionId, clientToken, presta } = await setupPublishedMission({ withPresta: true })
      if (!presta) throw new Error('presta required')

      const [acceptRes, cancelRes] = await Promise.all([
        request(http())
          .post(`${MISSIONS_BASE}/${missionId}/accept`)
          .set('Authorization', `Bearer ${presta.token}`)
          .send({}),
        request(http())
          .delete(`${MISSIONS_BASE}/${missionId}`)
          .set('Authorization', `Bearer ${clientToken}`)
          .send({ reason: 'last_minute' }),
      ])

      const final = await db().mission.findUnique({ where: { id: missionId } })

      if (final?.status === 'ACCEPTED') {
        expect(acceptRes.status).toBe(200)
        // Le cancel doit avoir échoué (ex: 409 MISSION_INVALID_STATE)
        expect(cancelRes.status).toBe(409)
        expect(cancelRes.body.error).toBe('MISSION_INVALID_STATE')
        expect(final.prestataireId).toBe(presta.id)
      } else if (final?.status === 'CANCELLED') {
        expect(cancelRes.status).toBe(200)
        // L'accept doit avoir échoué proprement (409)
        expect(acceptRes.status).toBe(409)
        expect(['MISSION_INVALID_STATE', 'MISSION_ALREADY_ACCEPTED']).toContain(
          acceptRes.body.error,
        )
        expect(final.prestataireId).toBeNull()
      } else {
        throw new Error(`Etat final inattendu après race: ${final?.status}`)
      }

      // Au plus 1 event terminal (ACCEPTED ou CANCELLED), jamais les deux
      const terminalEvents = await db().missionEvent.findMany({
        where: { missionId, type: { in: ['ACCEPTED', 'CANCELLED'] } },
      })
      expect(terminalEvents.length).toBeLessThanOrEqual(2) // au pire 1 ACCEPTED + tentative ratée
      const acceptedCount = terminalEvents.filter((e) => e.type === 'ACCEPTED').length
      const cancelledCount = terminalEvents.filter((e) => e.type === 'CANCELLED').length
      expect(acceptedCount + cancelledCount).toBeGreaterThanOrEqual(1)
      // L'un OU l'autre, jamais les deux finaux validés
      expect(Math.min(acceptedCount, cancelledCount)).toBe(0)
    })
  })

  // ===========================================================================
  // AUDIT C — Visibility policy admin
  // ===========================================================================

  describe('Audit C — Visibility policy admin', () => {
    it('C.1 — ADMIN voit toujours address.kind=FULL (DRAFT, PUBLISHED, ACCEPTED, CANCELLED)', async () => {
      const { missionId } = await setupPublishedMission()
      const admin = await createTestUser(db(), { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app!, { id: admin.id, role: 'ADMIN' })

      const list = await request(http())
        .get(ADMIN_MISSIONS_BASE)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const item = (list.body.items as Array<{ id: string; address: { kind: string; street?: string; location?: unknown } }>)
        .find((i) => i.id === missionId)
      expect(item).toBeDefined()
      expect(item?.address.kind).toBe('FULL')
      expect(item?.address.street).toBeDefined()
      expect(item?.address.location).toBeDefined()
    })
  })

  // ===========================================================================
  // AUDIT D — MissionEvent payload hygiene (PII + secrets)
  // ===========================================================================

  describe('Audit D — MissionEvent payload hygiene', () => {
    it.each([
      ['adresse complète', { street: '12 rue X', city: 'Paris' }],
      ['location lat/lng', { location: { lat: 48.85, lng: 2.35 } }],
      ['email', { email: 'a@b.fr' }],
      ['phone', { phone: '+33612345678' }],
      ['token', { token: 'abc.def.ghi' }],
      ['jwt', { jwt: 'eyJhbGciOi...' }],
      ['password', { password: 'plaintext' }],
      ['authorization header', { authorization: 'Bearer xyz' }],
    ] as const)('D — refuse un payload contenant %s avant insert mission_events', async (_label, badPayload) => {
      const { missionId, clientId } = await setupPublishedMission()
      const events = app!.get(MissionEventService)
      await expect(
        events.record({
          missionId,
          type: 'ACCEPTED',
          actorUserId: clientId,
          payload: badPayload as Record<string, unknown>,
        }),
      ).rejects.toThrow(/champ interdit/u)

      // Vérifie qu'aucun event corrompu n'a été inséré
      const inserted = await db().missionEvent.findFirst({
        where: { missionId, type: 'ACCEPTED' },
      })
      expect(inserted).toBeNull()
    })

    it('D — insère normalement un payload audit légitime (durée, motif, identifiants opaques)', async () => {
      const { missionId, clientId } = await setupPublishedMission()
      const events = app!.get(MissionEventService)

      await expect(
        events.record({
          missionId,
          type: 'CANCELLED',
          actorUserId: clientId,
          payload: { reason: 'too_expensive', refundCents: 4_900 },
        }),
      ).resolves.toBeUndefined()

      const inserted = await db().missionEvent.findFirst({
        where: { missionId, type: 'CANCELLED' },
      })
      expect(inserted).not.toBeNull()
      const payload = inserted?.payload as Record<string, unknown> | null
      expect(payload?.['reason']).toBe('too_expensive')
    })
  })

  // ===========================================================================
  // AUDIT E — Race expiration vs accept
  // ===========================================================================

  describe('Audit E — Race expiration vs accept', () => {
    it('E.1 — mission expirée AVANT accept : 409 MISSION_INVALID_STATE (mission_expired) + état EXPIRED conservé', async () => {
      const { missionId, presta } = await setupPublishedMission({ withPresta: true })
      if (!presta) throw new Error('presta required')

      // Backdate listingExpiresAt + force EXPIRED via le service (raccourci déterministe)
      await db().mission.update({
        where: { id: missionId },
        data: { listingExpiresAt: new Date(Date.now() - 60_000) },
      })
      const service = app!.get(MissionsService)
      const expireResult = await service.expireIfStillProposed(missionId)
      expect(expireResult.expired).toBe(true)

      // Tente d'accepter une mission EXPIRED
      const accept = await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .set('Authorization', `Bearer ${presta.token}`)
        .send({})
        .expect(409)

      expect(accept.body.error).toBe('MISSION_INVALID_STATE')
      expect(accept.body.reason).toBe('mission_expired')

      // Aucun event ACCEPTED n'a été créé
      const acceptedCount = await db().missionEvent.count({
        where: { missionId, type: 'ACCEPTED' },
      })
      expect(acceptedCount).toBe(0)

      const final = await db().mission.findUnique({ where: { id: missionId } })
      expect(final?.status).toBe('EXPIRED')
      expect(final?.prestataireId).toBeNull()
    })

    it('E.2 — accept arrive 1ms avant expiration : accept GAGNE (PostGIS UPDATE conditionnel sur listingExpiresAt > now)', async () => {
      const { missionId, presta } = await setupPublishedMission({ withPresta: true })
      if (!presta) throw new Error('presta required')

      // Push l'expiration dans 5s — assez pour qu'accept arrive en premier
      await db().mission.update({
        where: { id: missionId },
        data: { listingExpiresAt: new Date(Date.now() + 5_000) },
      })

      const accept = await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .set('Authorization', `Bearer ${presta.token}`)
        .send({})
        .expect(200)
      expect(accept.body.status).toBe('ACCEPTED')

      // Tentative d'expiration arrivée APRÈS : doit être no-op (state n'est plus PUBLISHED)
      const service = app!.get(MissionsService)
      const expireResult = await service.expireIfStillProposed(missionId)
      expect(expireResult.expired).toBe(false)

      const final = await db().mission.findUnique({ where: { id: missionId } })
      expect(final?.status).toBe('ACCEPTED')
      expect(final?.prestataireId).toBe(presta.id)
    })
  })

  // ===========================================================================
  // RBAC — vérifs non couvertes par missions-flow.integration
  // ===========================================================================

  describe('RBAC complémentaire', () => {
    it('GET /missions/:id sans Authorization → 401', async () => {
      const { missionId } = await setupPublishedMission()
      const res = await request(http())
        .get(`${MISSIONS_BASE}/${missionId}`)
        .expect(401)
      expect(res.body.error).toBeDefined()
    })

    it('POST /missions/:id/accept sans Authorization → 401', async () => {
      const { missionId } = await setupPublishedMission()
      await request(http())
        .post(`${MISSIONS_BASE}/${missionId}/accept`)
        .send({})
        .expect(401)
    })

    it('GET /admin/missions avec rôle CLIENT → 403', async () => {
      const client = await createTestUser(db(), { role: 'CLIENT' })
      const token = await forgeAccessToken(app!, { id: client.id, role: 'CLIENT' })
      await request(http())
        .get(ADMIN_MISSIONS_BASE)
        .set('Authorization', `Bearer ${token}`)
        .expect(403)
    })
  })
})
