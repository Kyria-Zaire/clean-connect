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

    // `FIN-STALE-RUNS` — fail-safe : balaie **tous** les types avant chaque
    // tick reconcile (3:30 EU/Paris = creux trafic). Aucun lock requis, juste
    // un `updateMany` sur les rows stale > TTL. Coût négligeable.
    await this.repo.markAllStaleRunningRunsFailed(FINANCE_RUN_TYPE_MAX_AGE_MS)

    const outcome = await this.locks.withLock(FINANCE_LOCK_KEYS.reconcile, FINANCE_LOCK_TTL_MS.reconcile, async () => {
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
