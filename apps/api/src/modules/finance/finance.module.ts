/**
 * PRD-004 Ticket 4.5 — `FinanceModule`.
 *
 * Boundary Nest pour le monitoring financier (reconciliation read-only Stripe,
 * stuck funds, invariants J-1, payout anomaly, daily report, retention/purge,
 * endpoints admin `/v1/admin/finance/*`).
 *
 * DI :
 *  - `ObservabilityModule` importé pour accéder à `MetricsService` (registry
 *    Prometheus global `@Global()` via `MetricsModule` — ADR-014).
 *  - `AuthModule` importé pour `JwtAccessGuard` + `RolesGuard` sur les
 *    controllers admin finance.
 *  - `ScheduleModule.forRoot()` est déjà activé globalement par `PaymentsModule`
 *    — on ne le ré-importe pas ici (évite double bootstrap `@nestjs/schedule`).
 *
 * Feature flag :
 *  - `FF_FINANCE_MONITORING_ENABLED` (env.ts) — quand `false`, les schedulers
 *    court-circuitent leur tick (log `finance.scheduler.disabled`).
 */

import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { ObservabilityModule } from '../observability/observability.module'
import { StripeClientFactory, STRIPE_CLIENT_TOKEN } from '../payments/stripe/stripe.client'

import { FinanceAlertingService } from './alerting/finance-alerting.service'
import { AdminFinanceController } from './controllers/admin-finance.controller'
import { FinanceRepository } from './finance.repository'
import { FinanceSchedulerLockService } from './locking/finance-scheduler-lock.service'
import { FinanceMetricsTracker } from './metrics/finance-metrics.tracker'
import { FinanceDailyReportScheduler } from './schedulers/finance-daily-report.scheduler'
import { FinanceInvariantsScheduler } from './schedulers/finance-invariants.scheduler'
import { FinancePayoutAnomalyScheduler } from './schedulers/finance-payout-anomaly.scheduler'
import { FinanceReconcileScheduler } from './schedulers/finance-reconcile.scheduler'
import { FinanceRetentionScheduler } from './schedulers/finance-retention.scheduler'
import { FinanceStuckFundsScheduler } from './schedulers/finance-stuck-funds.scheduler'
import { FinanceDailyReportService } from './services/finance-daily-report.service'
import { FinanceInvariantsService } from './services/finance-invariants.service'
import { FinanceMismatchService } from './services/finance-mismatch.service'
import { FinancePayoutAnomalyService } from './services/finance-payout-anomaly.service'
import { FinanceReconcileService } from './services/finance-reconcile.service'
import { FinanceRetentionService } from './services/finance-retention.service'
import { FinanceStuckFundsService } from './services/finance-stuck-funds.service'
import { StripeFinanceRetrieveService } from './stripe/stripe-finance-retrieve.service'

@Module({
  imports: [ObservabilityModule, AuthModule],
  controllers: [AdminFinanceController],
  providers: [
    StripeClientFactory,
    {
      provide: STRIPE_CLIENT_TOKEN,
      useFactory: (factory: StripeClientFactory) => factory.build(),
      inject: [StripeClientFactory],
    },
    FinanceSchedulerLockService,
    FinanceMetricsTracker,
    FinanceAlertingService,
    FinanceRepository,
    StripeFinanceRetrieveService,
    FinanceMismatchService,
    FinanceReconcileService,
    FinanceStuckFundsService,
    FinanceInvariantsService,
    FinancePayoutAnomalyService,
    FinanceDailyReportService,
    FinanceRetentionService,
    FinanceReconcileScheduler,
    FinanceStuckFundsScheduler,
    FinanceInvariantsScheduler,
    FinancePayoutAnomalyScheduler,
    FinanceDailyReportScheduler,
    FinanceRetentionScheduler,
  ],
  exports: [FinanceRepository, FinanceMismatchService],
})
export class FinanceModule {}
