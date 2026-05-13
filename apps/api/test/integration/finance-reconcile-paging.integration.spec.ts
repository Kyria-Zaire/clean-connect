/**
 * PRD-004 §4.15.17 — `FIN-RECONCILE-PAGING` (#25).
 *
 * Valide la pagination cursor `updatedAt,id` + boucle bornée (`maxPages`) sur
 * le reconcile. Variables d'env injectées **avant** bootstrap `AppModule`.
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'
import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { FinanceReconcileService } from '../../src/modules/finance/services/finance-reconcile.service'
import { StripeFinanceRetrieveService } from '../../src/modules/finance/stripe/stripe-finance-retrieve.service'

import { createTestUser } from './missions-helpers'

jest.setTimeout(180_000)

describe('FIN-RECONCILE-PAGING — cursor pagination reconcile', () => {
  let app: INestApplication
  let prisma: PrismaService
  let reconcile: FinanceReconcileService

  const cleanupMissionIds: string[] = []
  const cleanupAddressIds: string[] = []
  const cleanupRunIds: string[] = []

  beforeAll(async () => {
    __resetEnvCacheForTests()
    process.env['FF_FINANCE_MONITORING_ENABLED'] = 'false'
    process.env['FINANCE_RECONCILE_BATCH_SIZE'] = '2'
    process.env['FINANCE_RECONCILE_MAX_PAGES'] = '10'
    process.env['FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR'] = '60'

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeFinanceRetrieveService)
      .useValue(new PagingStripeStub())
      .compile()

    app = moduleRef.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(PinoLogger))
    app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
    app.enableVersioning({ type: VersioningType.URI })

    await app.init()
    prisma = app.get(PrismaService)
    reconcile = app.get(FinanceReconcileService)
  })

  afterAll(async () => {
    if (cleanupRunIds.length > 0) {
      await prisma.financeAlert.deleteMany({ where: { runId: { in: cleanupRunIds } } })
      await prisma.financeMismatch.deleteMany({ where: { runId: { in: cleanupRunIds } } })
      await prisma.financeReconciliationRun.deleteMany({ where: { id: { in: cleanupRunIds } } })
    }
    if (cleanupMissionIds.length > 0) {
      await prisma.transfer.deleteMany({ where: { payment: { missionId: { in: cleanupMissionIds } } } })
      await prisma.payment.deleteMany({ where: { missionId: { in: cleanupMissionIds } } })
      await prisma.mission.deleteMany({ where: { id: { in: cleanupMissionIds } } })
    }
    if (cleanupAddressIds.length > 0) {
      await prisma.address.deleteMany({ where: { id: { in: cleanupAddressIds } } })
    }
    await prisma.$executeRaw`DELETE FROM finance_scheduler_locks WHERE key = 'finance.reconcile'`
    await app.close()
  })

  it('scanne > batchSize payments via plusieurs pages cursor', async () => {
    const client = await createTestUser(prisma, { role: 'CLIENT' })
    const prest = await createTestUser(prisma, { role: 'PRESTATAIRE' })

    const addressRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "addresses" ("id", "street", "city", "zip_code", "country", "location", "created_at", "updated_at")
      VALUES (
        gen_random_uuid(), 'paging street', 'Paris', '75001', 'FR',
        ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326)::geography, NOW(), NOW()
      )
      RETURNING "id"::text
    `
    const addressId = addressRows[0]?.id ?? ''
    cleanupAddressIds.push(addressId)

    const base = Date.now()
    const n = 7
    for (let i = 0; i < n; i += 1) {
      const updatedAt = new Date(base - i * 1000)

      const m = await prisma.mission.create({
        data: {
          missionNumber: `CC-PAGE-${i}-${randomUUID().slice(0, 6).toUpperCase()}`,
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
      cleanupMissionIds.push(m.id)

      await prisma.payment.create({
        data: {
          missionId: m.id,
          stripePaymentIntentId: `pi_page_${i}_${randomUUID()}`,
          idempotencyKey: `idemp-page-${i}-${randomUUID()}`,
          amountAuthorizedCents: 1000,
          amountCapturedCents: 1000,
          currency: 'eur',
          applicationFeeCents: 180,
          providerPayoutCents: 820,
          status: 'CAPTURED',
          updatedAt,
        },
      })
    }

    const { runId } = await reconcile.runManual('00000000-0000-4000-8000-000000000eee')
    cleanupRunIds.push(runId)

    const run = await prisma.financeReconciliationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { resourcesScanned: true, status: true },
    })
    expect(run.status).toBe('COMPLETED')
    expect(run.resourcesScanned).toBeGreaterThanOrEqual(n)
  })
})

/**
 * Retourne un PI minimal avec `amount_received` aligné sur le Payment scanné
 * (évite les faux positifs FIN-I-006 pendant le test de pagination).
 */
class PagingStripeStub {
  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent | null> {
    return {
      id,
      object: 'payment_intent',
      status: 'succeeded',
      amount_received: 1000,
      amount: 1000,
      currency: 'eur',
      application_fee_amount: 180,
    } as Stripe.PaymentIntent
  }

  async retrieveTransfer(): Promise<null> {
    return null
  }

  async retrieveRefund(): Promise<null> {
    return null
  }
}
