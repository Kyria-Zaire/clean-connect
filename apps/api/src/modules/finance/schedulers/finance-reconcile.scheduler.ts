import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_CRON, FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_TIMEZONE } from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'
import { FinanceReconcileService } from '../services/finance-reconcile.service'

@Injectable()
export class FinanceReconcileScheduler {
  private readonly logger = new Logger(FinanceReconcileScheduler.name)

  constructor(
    private readonly locks: FinanceSchedulerLockService,
    private readonly repo: FinanceRepository,
    private readonly reconcile: FinanceReconcileService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  @Cron(FINANCE_CRON.reconcile, { name: 'finance-reconcile', timeZone: FINANCE_TIMEZONE })
  async tick(): Promise<void> {
    const env = loadEnv()
    if (!env.FF_FINANCE_MONITORING_ENABLED) {
      this.logger.debug('finance.reconcile.disabled')
      return
    }

    const outcome = await this.locks.withLock(FINANCE_LOCK_KEYS.reconcile, FINANCE_LOCK_TTL_MS.reconcile, async () => {
      await this.repo.markStaleRunningRunsFailed('RECONCILE', FINANCE_LOCK_TTL_MS.reconcile)
      return this.reconcile.runScheduledReconcile()
    })

    if (!outcome.acquired) {
      this.logger.warn('finance.reconcile.lock_busy')
      return
    }

    // Refresh open mismatch gauges (cheap query).
    const open = await this.repo.countOpenMismatchesBySeverity()
    this.metrics.setOpenMismatches(open)
  }
}
