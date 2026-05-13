/**
 * PRD-004 Ticket 4.5 — Tests d'intégration finance (RBAC + lock + cooldown + retention).
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
import { FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS } from '../../src/modules/finance/finance.constants'
import { FinanceReconcileService } from '../../src/modules/finance/services/finance-reconcile.service'
import { FinanceRetentionService } from '../../src/modules/finance/services/finance-retention.service'
import { FinanceSchedulerLockService } from '../../src/modules/finance/locking/finance-scheduler-lock.service'

import { createTestUser, forgeAccessToken } from './missions-helpers'

jest.setTimeout(120_000)

describe('PRD-004 Ticket 4.5 — finance monitoring (integration)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeAll(async () => {
    __resetEnvCacheForTests()
    process.env['FF_FINANCE_MONITORING_ENABLED'] = 'false'

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleRef.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(PinoLogger))
    app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
    app.enableVersioning({ type: VersioningType.URI })

    await app.init()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await prisma.financeSchedulerLock.deleteMany({ where: { key: FINANCE_LOCK_KEYS.reconcile } })
    await prisma.financeMismatch.deleteMany({ where: { resourceId: { startsWith: 'it-finance-' } } })
    await prisma.financeReconciliationRun.deleteMany({ where: { failureMessage: 'it-finance-retention' } })
    await prisma.financeAlert.deleteMany({ where: { kind: 'finance_mismatch' } })
    await app.close()
  })

  it('RBAC — /api/v1/admin/finance/mismatches : 401 sans token, 403 CLIENT, 200 ADMIN', async () => {
    const admin = await createTestUser(prisma, { role: 'ADMIN' })
    const client = await createTestUser(prisma, { role: 'CLIENT' })

    const adminToken = await forgeAccessToken(app, { id: admin.id, role: 'ADMIN' })
    const clientToken = await forgeAccessToken(app, { id: client.id, role: 'CLIENT' })

    await request(app.getHttpServer()).get('/v1/admin/finance/mismatches').expect(401)

    await request(app.getHttpServer())
      .get('/v1/admin/finance/mismatches')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(403)

    await request(app.getHttpServer())
      .get('/v1/admin/finance/mismatches')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
  })

  it('FinanceSchedulerLockService — busy puis release OK', async () => {
    const locks = app.get(FinanceSchedulerLockService)
    const key = FINANCE_LOCK_KEYS.reconcile

    const a = await locks.tryAcquire(key, FINANCE_LOCK_TTL_MS.reconcile)
    expect(a).not.toBeNull()
    expect(await locks.tryAcquire(key, FINANCE_LOCK_TTL_MS.reconcile)).toBeNull()
    await locks.release(a!)
    const b = await locks.tryAcquire(key, FINANCE_LOCK_TTL_MS.reconcile)
    expect(b).not.toBeNull()
    await locks.release(b!)
  })

  it('FinanceAlertingService — cooldown empêche le double emit', async () => {
    const alerting = app.get(FinanceAlertingService)
    alerting.__resetCooldownForTests()

    const first = await alerting.emit({
      kind: 'finance_mismatch',
      severity: 'P1',
      cooldownScope: 'STATUS',
      context: { mismatchType: 'STATUS' },
    })
    expect(first.emitted).toBe(true)

    const second = await alerting.emit({
      kind: 'finance_mismatch',
      severity: 'P1',
      cooldownScope: 'STATUS',
      context: { mismatchType: 'STATUS' },
    })
    expect(second.emitted).toBe(false)
    expect(second.reason).toBe('cooldown')
  })

  it('FinanceRetentionService — purge RESOLVED/IGNORED anciens', async () => {
    const run = await prisma.financeReconciliationRun.create({
      data: {
        type: 'RECONCILE',
        status: 'COMPLETED',
        windowFrom: new Date(),
        windowTo: new Date(),
        failureMessage: 'it-finance-retention',
      },
      select: { id: true },
    })

    const resourceId = `it-finance-${randomUUID()}`
    await prisma.financeMismatch.create({
      data: {
        runId: run.id,
        mismatchCode: 'FIN-I-001',
        type: 'STATUS',
        resourceKind: 'PAYMENT',
        resourceId,
        severity: 'P1',
        dbSnapshot: { id: resourceId, status: 'CAPTURED' },
        status: 'RESOLVED',
        resolvedAt: new Date(Date.now() - 120 * 24 * 60 * 60_000),
        resolvedByUserId: null,
      },
    })

    const before = await prisma.financeMismatch.count({ where: { resourceId } })
    expect(before).toBe(1)

    const retention = app.get(FinanceRetentionService)
    await retention.run()

    const after = await prisma.financeMismatch.count({ where: { resourceId } })
    expect(after).toBe(0)
  })

  it('FinanceRetentionService — purge OPEN/INVESTIGATING au-delà de la fenêtre (pas de rétention indéfinie)', async () => {
    const run = await prisma.financeReconciliationRun.create({
      data: {
        type: 'RECONCILE',
        status: 'COMPLETED',
        windowFrom: new Date(),
        windowTo: new Date(),
        failureMessage: 'it-finance-retention',
      },
      select: { id: true },
    })

    const resourceId = `it-finance-${randomUUID()}`
    const oldDetectedAt = new Date(Date.now() - 120 * 24 * 60 * 60_000)

    await prisma.financeMismatch.create({
      data: {
        runId: run.id,
        mismatchCode: 'FIN-I-001',
        type: 'STATUS',
        resourceKind: 'PAYMENT',
        resourceId,
        severity: 'P1',
        dbSnapshot: { id: resourceId, status: 'CAPTURED' },
        status: 'OPEN',
        detectedAt: oldDetectedAt,
      },
    })

    expect(await prisma.financeMismatch.count({ where: { resourceId } })).toBe(1)

    const retention = app.get(FinanceRetentionService)
    await retention.run()

    expect(await prisma.financeMismatch.count({ where: { resourceId } })).toBe(0)
  })

  it('FinanceReconcileService.runManual — refuse 409 si le lock reconcile est déjà tenu (anti-doublon CTO)', async () => {
    const reconcile = app.get(FinanceReconcileService)
    const locks = app.get(FinanceSchedulerLockService)
    const key = FINANCE_LOCK_KEYS.reconcile
    /** UUID frais : le quota manuel 1/h est par admin ; un id fixe collisionne avec d'autres specs DB partagée. */
    const adminUserId = randomUUID()

    const beforeRunCount = await prisma.financeReconciliationRun.count({
      where: { type: 'RECONCILE' },
    })

    const handle = await locks.tryAcquire(key, FINANCE_LOCK_TTL_MS.reconcile)
    expect(handle).not.toBeNull()

    try {
      await expect(reconcile.runManual(adminUserId)).rejects.toMatchObject({ status: 409 })
    } finally {
      await locks.release(handle!)
    }

    const afterRunCount = await prisma.financeReconciliationRun.count({
      where: { type: 'RECONCILE' },
    })
    // FIN-MANUAL-RATELIMIT : réservation atomique (1 row RUNNING) avant le lock ;
    // lock busy → failRun(`lock_busy`) — une ligne d'audit FAILED, pas de zombie RUNNING.
    expect(afterRunCount).toBe(beforeRunCount + 1)

    const failedLockBusy = await prisma.financeReconciliationRun.findFirst({
      where: {
        type: 'RECONCILE',
        status: 'FAILED',
        failureMessage: 'lock_busy',
        triggeredByUserId: adminUserId,
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, completedAt: true },
    })
    expect(failedLockBusy).not.toBeNull()
    expect(failedLockBusy!.completedAt).not.toBeNull()
  })
})
