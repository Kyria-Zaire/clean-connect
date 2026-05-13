import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinancePayoutAnomalyService } from '../services/finance-payout-anomaly.service'

@Injectable()
export class FinancePayoutAnomalyScheduler {
  private readonly logger = new Logger(FinancePayoutAnomalyScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly payout: FinancePayoutAnomalyService,
  ) {}

  @Cron(FINANCE_CRON.payoutAnomaly, { name: 'finance-payout-anomaly', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.payout_anomaly.disabled')
      return
    }

    const outcome = await this.locks.withLock(
      FINANCE_LOCK_KEYS.payoutAnomaly,
      FINANCE_LOCK_TTL_MS.payoutAnomaly,
      async () => {
        await this.payout.run()
      },
    )

    if (!outcome.acquired) this.logger.warn('finance.payout_anomaly.lock_busy')
  }
}
