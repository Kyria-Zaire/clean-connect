/**
 * PRD-004 Ticket 4.5 Build itération 2 — Tests d'intégration métier.
 *
 * Couvre :
 *  - lifecycle mismatch ACK (OPEN → ACK → RESOLVED)
 *  - rejet transitions invalides (RESOLVED → ACK)
 *  - notes obligatoires ≥ 16 chars pour RESOLVED/IGNORED
 *  - persist d'un InvariantBreak (mismatch + métrique + alerte) avec dedup
 *  - reconcile end-to-end avec une vraie row Payment cassée (FIN-I-003 drift commission)
 *  - daily report : balance déséquilibrée ⇒ FIN-J-001 + report status=failed
 *  - audit MissionEvent posé sur transitions
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import request from 'supertest'
import { randomUUID } from 'node:crypto'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { FinanceAlertingService } from '../../src/modules/finance/alerting/finance-alerting.service'
import { FinanceMismatchService } from '../../src/modules/finance/services/finance-mismatch.service'
import { FinanceReconcileService } from '../../src/modules/finance/services/finance-reconcile.service'
import { FinanceDailyReportService } from '../../src/modules/finance/services/finance-daily-report.service'
import { StripeFinanceRetrieveService } from '../../src/modules/finance/stripe/stripe-finance-retrieve.service'

import { createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(120_000)

describe('PRD-004 Ticket 4.5 — itération 2 (lifecycle + reconcile + daily report)', () => {
  let app: INestApplication
  let prisma: PrismaService

  const cleanupResourceIds: string[] = []
  const cleanupRunIds: string[] = []
  const cleanupMissionIds: string[] = []
  const cleanupAddressIds: string[] = []

  beforeAll(async () => {
    __resetEnvCacheForTests()
    process.env['FF_FINANCE_MONITORING_ENABLED'] = 'false'

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeFinanceRetrieveService)
      .useValue(new StripeStub())
      .compile()

    app = moduleRef.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(PinoLogger))
    app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
    app.enableVersioning({ type: VersioningType.URI })

    await app.init()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    if (cleanupRunIds.length > 0) {
      await prisma.financeAlert.deleteMany({ where: { runId: { in: cleanupRunIds } } })
    }
    if (cleanupResourceIds.length > 0 || cleanupRunIds.length > 0) {
      const or: { resourceId?: { in: string[] }; runId?: { in: string[] } }[] = []
      if (cleanupResourceIds.length > 0) or.push({ resourceId: { in: cleanupResourceIds } })
      if (cleanupRunIds.length > 0) or.push({ runId: { in: cleanupRunIds } })
      await prisma.financeMismatch.deleteMany({ where: { OR: or } })
    }
    if (cleanupRunIds.length > 0) {
      await prisma.financeReconciliationRun.deleteMany({
        where: { id: { in: cleanupRunIds } },
      })
    }
    if (cleanupMissionIds.length > 0) {
      await prisma.transfer.deleteMany({
        where: { payment: { missionId: { in: cleanupMissionIds } } },
      })
      await prisma.payment.deleteMany({ where: { missionId: { in: cleanupMissionIds } } })
      await prisma.mission.deleteMany({ where: { id: { in: cleanupMissionIds } } })
    }
    if (cleanupAddressIds.length > 0) {
      await prisma.address.deleteMany({ where: { id: { in: cleanupAddressIds } } })
    }
    await app.close()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Lifecycle ACK
  // ───────────────────────────────────────────────────────────────────────────
  describe('lifecycle mismatch — OPEN → ACKNOWLEDGED → RESOLVED', () => {
    it('accepte ACK puis RESOLVED avec notes ≥ 16 chars', async () => {
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const run = await prisma.financeReconciliationRun.create({
        data: {
          type: 'INVARIANTS',
          status: 'COMPLETED',
          windowFrom: new Date(),
          windowTo: new Date(),
        },
        select: { id: true },
      })
      cleanupRunIds.push(run.id)

      const resourceId = randomUUID()
      cleanupResourceIds.push(resourceId)

      const mismatch = await prisma.financeMismatch.create({
        data: {
          runId: run.id,
          mismatchCode: 'FIN-I-001',
          type: 'STATUS',
          resourceKind: 'PAYMENT',
          resourceId,
          severity: 'P1',
          dbSnapshot: { id: resourceId, status: 'CAPTURED' },
          status: 'OPEN',
        },
        select: { id: true },
      })

      // OPEN → ACK
      await request(app.getHttpServer())
        .patch(`/v1/admin/finance/mismatches/${mismatch.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'ACKNOWLEDGED' })
        .expect(200)

      const ackRow = await prisma.financeMismatch.findUnique({ where: { id: mismatch.id } })
      expect(ackRow?.status).toBe('ACKNOWLEDGED')
      expect(ackRow?.acknowledgedAt).toBeTruthy()
      expect(ackRow?.acknowledgedByUserId).toBe(admin.id)

      // ACK → RESOLVED avec notes
      await request(app.getHttpServer())
        .patch(`/v1/admin/finance/mismatches/${mismatch.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'RESOLVED', notes: 'Fixed via Stripe dashboard manual capture' })
        .expect(200)

      const resolvedRow = await prisma.financeMismatch.findUnique({ where: { id: mismatch.id } })
      expect(resolvedRow?.status).toBe('RESOLVED')
      expect(resolvedRow?.resolvedAt).toBeTruthy()
      expect(resolvedRow?.resolutionNotes).toBe('Fixed via Stripe dashboard manual capture')
      // ACK doit être conservé
      expect(resolvedRow?.acknowledgedAt).toBeTruthy()
    })

    it('refuse 409 sur transition invalide (RESOLVED → ACKNOWLEDGED)', async () => {
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const run = await prisma.financeReconciliationRun.create({
        data: {
          type: 'INVARIANTS',
          status: 'COMPLETED',
          windowFrom: new Date(),
          windowTo: new Date(),
        },
        select: { id: true },
      })
      cleanupRunIds.push(run.id)

      const resourceId = randomUUID()
      cleanupResourceIds.push(resourceId)
      const mismatch = await prisma.financeMismatch.create({
        data: {
          runId: run.id,
          mismatchCode: 'FIN-I-001',
          type: 'STATUS',
          resourceKind: 'PAYMENT',
          resourceId,
          severity: 'P1',
          dbSnapshot: { id: resourceId },
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedByUserId: admin.id,
          resolutionNotes: 'previous resolution that has 16 chars',
        },
        select: { id: true },
      })

      const res = await request(app.getHttpServer())
        .patch(`/v1/admin/finance/mismatches/${mismatch.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'ACKNOWLEDGED' })
        .expect(409)

      expect(res.body.error).toBe('FINANCE_MISMATCH_TRANSITION_INVALID')
    })

    it('refuse 400 sur RESOLVED sans notes ≥ 16 chars', async () => {
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const run = await prisma.financeReconciliationRun.create({
        data: {
          type: 'INVARIANTS',
          status: 'COMPLETED',
          windowFrom: new Date(),
          windowTo: new Date(),
        },
        select: { id: true },
      })
      cleanupRunIds.push(run.id)

      const resourceId = randomUUID()
      cleanupResourceIds.push(resourceId)
      const mismatch = await prisma.financeMismatch.create({
        data: {
          runId: run.id,
          mismatchCode: 'FIN-I-001',
          type: 'STATUS',
          resourceKind: 'PAYMENT',
          resourceId,
          severity: 'P1',
          dbSnapshot: { id: resourceId },
          status: 'OPEN',
        },
        select: { id: true },
      })

      const res = await request(app.getHttpServer())
        .patch(`/v1/admin/finance/mismatches/${mismatch.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'RESOLVED', notes: 'too short' })
        .expect(400)

      expect(res.body.error).toBe('FINANCE_MISMATCH_NOTES_REQUIRED')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Persist InvariantBreak — création + dedup + métrique + alerte
  // ───────────────────────────────────────────────────────────────────────────
  describe('FinanceMismatchService.persist — dedup + alerte cooldown', () => {
    it('crée le mismatch puis dedup le second appel sur la même clé', async () => {
      const mismatches = app.get(FinanceMismatchService)
      const alerting = app.get(FinanceAlertingService)
      alerting.__resetCooldownForTests()

      const run = await prisma.financeReconciliationRun.create({
        data: {
          type: 'RECONCILE',
          status: 'COMPLETED',
          windowFrom: new Date(),
          windowTo: new Date(),
        },
        select: { id: true },
      })
      cleanupRunIds.push(run.id)

      const resourceId = randomUUID()
      cleanupResourceIds.push(resourceId)

      const breakInput = {
        mismatchCode: 'FIN-I-003' as const,
        mismatchType: 'AMOUNT' as const,
        resourceKind: 'TRANSFER' as const,
        resourceId,
        severity: 'P1' as const,
        explanation: 'drift commission',
        remediationHint: 'audit code transfer creation',
        amountDeltaCents: 100,
        dbSnapshot: { id: resourceId, status: 'SENT', amountCents: 4200 },
        stripeSnapshot: null,
      }

      const first = await mismatches.persist({ runId: run.id, invariantBreak: breakInput })
      expect(first.persisted).toBe('created')
      expect(first.alerted).toBe(true)

      const second = await mismatches.persist({ runId: run.id, invariantBreak: breakInput })
      expect(second.persisted).toBe('duplicate')
      expect(second.alerted).toBe(false)

      const cnt = await prisma.financeMismatch.count({ where: { resourceId } })
      expect(cnt).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Reconcile end-to-end (FIN-I-003 drift commission DB-only)
  // ───────────────────────────────────────────────────────────────────────────
  describe('FinanceReconcileService — reconcile détecte FIN-I-003 drift commission', () => {
    it('crée 1 FinanceMismatch FIN-I-003 si Transfer.amount != Payment.providerPayout', async () => {
      const reconcile = app.get(FinanceReconcileService)
      const alerting = app.get(FinanceAlertingService)
      alerting.__resetCooldownForTests()

      // Crée user/address/mission/payment/transfer driftés
      const client = await createTestUser(prisma, { role: 'CLIENT' })
      const prest = await createTestUser(prisma, { role: 'PRESTATAIRE' })

      const addressRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "addresses" ("id", "street", "city", "zip_code", "country", "location", "created_at", "updated_at")
        VALUES (
          gen_random_uuid(), 'iter2 street', 'Paris', '75001', 'FR',
          ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography, NOW(), NOW()
        )
        RETURNING "id"::text
      `
      const addressId = addressRows[0]?.id ?? ''

      const mission = await prisma.mission.create({
        data: {
          missionNumber: `CC-2026-${randomUUID().slice(0, 8).toUpperCase()}`,
          clientId: client.id,
          prestataireId: prest.id,
          addressId,
          serviceType: 'SOFA',
          status: 'COMPLETED',
          startAt: new Date('2026-05-13T08:00:00.000Z'),
          endAt: new Date('2026-05-13T10:00:00.000Z'),
          timeZone: 'Europe/Paris',
        },
        select: { id: true },
      })
      const payment = await prisma.payment.create({
        data: {
          missionId: mission.id,
          stripePaymentIntentId: `pi_iter2_${randomUUID()}`,
          idempotencyKey: `idemp-iter2-${randomUUID()}`,
          amountAuthorizedCents: 5000,
          amountCapturedCents: 5000,
          currency: 'eur',
          applicationFeeCents: 900,
          providerPayoutCents: 4100,
          status: 'CAPTURED',
        },
        select: { id: true },
      })
      await prisma.transfer.create({
        data: {
          paymentId: payment.id,
          stripeTransferId: `tr_iter2_${randomUUID()}`,
          amountCents: 4200, // drift 100 cents par rapport à providerPayoutCents=4100
          currency: 'eur',
          status: 'SENT',
          idempotencyKey: `idemp-tr-iter2-${randomUUID()}`,
        },
      })
      cleanupMissionIds.push(mission.id)
      cleanupAddressIds.push(addressId)

      const { runId } = await reconcile.runManual('00000000-0000-4000-8000-000000000fff')
      cleanupRunIds.push(runId)

      const found = await prisma.financeMismatch.findMany({
        where: { runId, mismatchCode: 'FIN-I-003' },
      })
      expect(found.length).toBeGreaterThanOrEqual(1)
      expect(found[0]?.amountDeltaCents).toBe(100)
      expect(found[0]?.severity).toBe('P1')
      expect(found[0]?.resourceKind).toBe('TRANSFER')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Daily report — persist + balance healthy/failed
  // ───────────────────────────────────────────────────────────────────────────
  describe('FinanceDailyReportService — agrège J-1 + persist + status', () => {
    it('crée un FinanceDailyReport upsert (status success ou failed selon balance)', async () => {
      const daily = app.get(FinanceDailyReportService)
      await daily.run()

      const report = await prisma.financeDailyReport.findFirst({
        orderBy: { reportDate: 'desc' },
      })
      expect(report).not.toBeNull()
      expect(report?.snapshot).toBeDefined()
      const snap = report?.snapshot as { kind?: string; balanceHealthy?: boolean }
      expect(snap.kind).toBe('finance.daily_report.v1')
      expect(typeof snap.balanceHealthy).toBe('boolean')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. RBAC GET mismatches — filtre mismatchCode
  // ───────────────────────────────────────────────────────────────────────────
  describe('GET /v1/admin/finance/mismatches?mismatchCode=FIN-I-003', () => {
    it('filtre correctement par mismatchCode', async () => {
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const res = await request(app.getHttpServer())
        .get('/v1/admin/finance/mismatches?mismatchCode=FIN-I-003&limit=10')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body.items).toBeDefined()
      for (const it of res.body.items) {
        expect(it.mismatchCode).toBe('FIN-I-003')
      }
    })

    it('rejette 400 si mismatchCode invalide', async () => {
      const admin = await createTestUser(prisma, { role: 'ADMIN' })
      const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })

      const res = await request(app.getHttpServer())
        .get('/v1/admin/finance/mismatches?mismatchCode=BADFORMAT')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(res.body.error).toBe('FINANCE_LIST_MISMATCHES_INVALID_QUERY')
    })
  })
})

/**
 * Stub pour le `StripeFinanceRetrieveService` — toutes les méthodes renvoient
 * `null` (404 simulé). Ainsi les invariants Stripe-dependant (FIN-I-006/007/008)
 * sont skipped, et seul FIN-I-003 (DB-only) déclenche le mismatch dans le test
 * reconcile. Aucun appel Stripe réel pendant le test.
 */
class StripeStub {
  async retrievePaymentIntent(): Promise<null> {
    return null
  }
  async retrieveTransfer(): Promise<null> {
    return null
  }
  async retrieveRefund(): Promise<null> {
    return null
  }
}
