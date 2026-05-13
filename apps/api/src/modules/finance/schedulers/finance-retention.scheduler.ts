import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import {
  FINANCE_CRON,
  FINANCE_LOCK_KEYS,
  FINANCE_LOCK_TTL_MS,
  FINANCE_RUN_TYPE_MAX_AGE_MS,
  FINANCE_TIMEZONE,
} from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceRetentionService } from '../services/finance-retention.service'

@Injectable()
export class FinanceRetentionScheduler {
  private readonly logger = new Logger(FinanceRetentionScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly repo: FinanceRepository,
    private readonly retention: FinanceRetentionService,
  ) {}

  @Cron(FINANCE_CRON.retention, { name: 'finance-retention', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.retention.disabled')
      return
    }

    // `FIN-STALE-RUNS` — pre-tick cleanup tous types (même si retention ne crée
    // pas de `FinanceReconciliationRun`, on garde le même pattern fail-safe).
    await this.repo.markAllStaleRunningRunsFailed(FINANCE_RUN_TYPE_MAX_AGE_MS)

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
