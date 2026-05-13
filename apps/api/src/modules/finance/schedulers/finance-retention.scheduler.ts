import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceRetentionService } from '../services/finance-retention.service'

@Injectable()
export class FinanceRetentionScheduler {
  private readonly logger = new Logger(FinanceRetentionScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly retention: FinanceRetentionService,
  ) {}

  @Cron(FINANCE_CRON.retention, { name: 'finance-retention', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.retention.disabled')
      return
    }

    const outcome = await this.locks.withLock(
      FINANCE_LOCK_KEYS.retention,
      FINANCE_LOCK_TTL_MS.retention,
      async () => {
        await this.retention.run()
      },
    )

    if (!outcome.acquired) this.logger.warn('finance.retention.lock_busy')
  }
}
