import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceInvariantsService } from '../services/finance-invariants.service'

@Injectable()
export class FinanceInvariantsScheduler {
  private readonly logger = new Logger(FinanceInvariantsScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly invariants: FinanceInvariantsService,
  ) {}

  @Cron(FINANCE_CRON.invariants, { name: 'finance-invariants', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.invariants.disabled')
      return
    }

    const outcome = await this.locks.withLock(
      FINANCE_LOCK_KEYS.invariants,
      FINANCE_LOCK_TTL_MS.invariants,
      async () => {
        await this.invariants.run()
      },
    )

    if (!outcome.acquired) this.logger.warn('finance.invariants.lock_busy')
  }
}
