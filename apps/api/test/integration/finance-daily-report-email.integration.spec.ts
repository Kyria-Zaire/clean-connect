/**
 * PRD-004 §4.15.17 — `FIN-DAILY-EMAIL` (#24) — envoi Resend + alerte P1 si échec.
 */

import type { INestApplication } from '@nestjs/common'
import { VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger as PinoLogger } from 'nestjs-pino'

import { AppModule } from '../../src/app.module'
import { __resetEnvCacheForTests } from '../../src/common/config/env'
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter'
import { PrismaService } from '../../src/common/prisma/prisma.service'
import { FinanceAlertingService } from '../../src/modules/finance/alerting/finance-alerting.service'
import { FinanceDailyReportService } from '../../src/modules/finance/services/finance-daily-report.service'

jest.setTimeout(120_000)

describe('FIN-DAILY-EMAIL — Resend + alerte P1', () => {
  let app: INestApplication
  let prisma: PrismaService
  let daily: FinanceDailyReportService
  let alerting: FinanceAlertingService
  const cleanupRunIds: string[] = []

  beforeAll(async () => {
    __resetEnvCacheForTests()
    process.env['FF_FINANCE_MONITORING_ENABLED'] = 'false'
    process.env['RESEND_API_KEY'] = 're_test_minimum8chars'
    process.env['FINANCE_DAILY_REPORT_EMAIL_TO'] = 'finance-ops-test@example.com'
    process.env['RESEND_FROM_EMAIL'] = 'finance-sender-test@example.com'

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(PinoLogger))
    app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))
    app.enableVersioning({ type: VersioningType.URI })

    await app.init()
    prisma = app.get(PrismaService)
    daily = app.get(FinanceDailyReportService)
    alerting = app.get(FinanceAlertingService)
  })

  afterAll(async () => {
    if (cleanupRunIds.length > 0) {
      await prisma.financeAlert.deleteMany({ where: { runId: { in: cleanupRunIds } } })
      await prisma.financeReconciliationRun.deleteMany({ where: { id: { in: cleanupRunIds } } })
    }
    await prisma.financeAlert.deleteMany({ where: { kind: 'finance_daily_report_failed' } })
    await app.close()
  })

  beforeEach(() => {
    alerting.__resetCooldownForTests()
  })

  it('POST https://api.resend.com/emails quand fetch répond 200', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 're_dummy' }),
    } as unknown as Response)

    try {
      await daily.run()
      const lastRun = await prisma.financeReconciliationRun.findFirst({
        where: { type: 'REPORT' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      })
      if (lastRun?.id) cleanupRunIds.push(lastRun.id)

      expect(fetchSpy).toHaveBeenCalled()
      const first = fetchSpy.mock.calls[0]
      expect(first?.[0]).toBe('https://api.resend.com/emails')
      const init = first?.[1] as RequestInit
      expect(init?.method).toBe('POST')
      expect(String(init?.headers && (init.headers as Record<string, string>)['Authorization'])).toContain(
        'Bearer re_test',
      )

      const alerts = await prisma.financeAlert.count({
        where: { kind: 'finance_daily_report_failed' },
      })
      expect(alerts).toBe(0)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('422 Resend → alerte P1 finance_daily_report_failed (stage=email)', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid"}',
    } as unknown as Response)

    try {
      await daily.run()
      const lastRun = await prisma.financeReconciliationRun.findFirst({
        where: { type: 'REPORT' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      })
      if (lastRun?.id) cleanupRunIds.push(lastRun.id)

      const row = await prisma.financeAlert.findFirst({
        where: { kind: 'finance_daily_report_failed' },
        orderBy: { emittedAt: 'desc' },
      })
      expect(row).not.toBeNull()
      expect(row?.severity).toBe('P1')
      const ctx = row?.context as { stage?: string }
      expect(ctx.stage).toBe('email')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
