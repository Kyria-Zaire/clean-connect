import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceStuckFundsService } from '../services/finance-stuck-funds.service'

@Injectable()
export class FinanceStuckFundsScheduler {
  private readonly logger = new Logger(FinanceStuckFundsScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly stuck: FinanceStuckFundsService,
  ) {}

  @Cron(FINANCE_CRON.stuckFunds, { name: 'finance-stuck-funds', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.stuck.disabled')
      return
    }

    const outcome = await this.locks.withLock(FINANCE_LOCK_KEYS.stuck, FINANCE_LOCK_TTL_MS.stuck, async () => {
      await this.stuck.run()
    })

    if (!outcome.acquired) this.logger.warn('finance.stuck.lock_busy')
  }
}
