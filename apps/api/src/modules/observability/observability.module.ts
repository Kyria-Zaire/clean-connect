/**
 * Barrel — module Observability (PRD-004 Ticket 4.1).
 *
 * Build A1 : Sentry (errors + APM).
 * Build A2 : Pino hardening (géré côté `app.module.ts` — `LoggerModule`).
 * Build A3 : Prometheus metrics (`MetricsModule` — registry + endpoint +
 *            HTTP interceptor + BullMQ listener).
 */

import { Module } from '@nestjs/common'

import { MetricsModule } from './metrics/metrics.module'
import { SentryModule } from './sentry/sentry.module'

@Module({
  imports: [SentryModule, MetricsModule],
  exports: [SentryModule, MetricsModule],
})
export class ObservabilityModule {}
