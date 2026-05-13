import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceDailyReportService } from '../services/finance-daily-report.service'

@Injectable()
export class FinanceDailyReportScheduler {
  private readonly logger = new Logger(FinanceDailyReportScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly report: FinanceDailyReportService,
  ) {}

  @Cron(FINANCE_CRON.dailyReport, { name: 'finance-daily-report', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.daily_report.disabled')
      return
    }

    const outcome = await this.locks.withLock(FINANCE_LOCK_KEYS.report, FINANCE_LOCK_TTL_MS.report, async () => {
      await this.report.run()
    })

    if (!outcome.acquired) this.logger.warn('finance.daily_report.lock_busy')
  }
}
