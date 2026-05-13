import { Injectable, Logger } from '@nestjs/common'

import { loadEnv } from '../../../common/config/env'
import { FinanceRepository } from '../finance.repository'

@Injectable()
export class FinanceRetentionService {
  private readonly logger = new Logger(FinanceRetentionService.name)

  constructor(private readonly repo: FinanceRepository) {}

  async run(): Promise<void> {
    const env = loadEnv()
    const now = Date.now()

    const mismatchCutoff = new Date(now - env.FINANCE_MISMATCH_RETENTION_DAYS * 24 * 60 * 60_000)
    const reportCutoff = new Date(now - env.FINANCE_DAILY_REPORT_RETENTION_DAYS * 24 * 60 * 60_000)
    const alertCutoff = new Date(now - env.FINANCE_ALERT_RETENTION_DAYS * 24 * 60 * 60_000)
    const runCutoff = new Date(now - 90 * 24 * 60 * 60_000)

    const deletedMismatches = await this.repo.purgeMismatchesPastRetention(mismatchCutoff)
    const deletedReports = await this.repo.purgeDailyReportsOlderThan(reportCutoff)
    const deletedAlerts = await this.repo.purgeAlertsOlderThan(alertCutoff)
    const deletedRuns = await this.repo.purgeCompletedRunsOlderThan(runCutoff)

    this.logger.log({
      msg: 'finance.retention.done',
      deletedMismatches,
      deletedReports,
      deletedAlerts,
      deletedRuns,
    })
  }
}
