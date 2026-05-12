/**
 * Barrel — module Observability (PRD-004 Ticket 4.1).
 *
 * Build A1 : Sentry (errors + APM).
 * Build A2 : Pino hardening (géré côté `app.module.ts` — `LoggerModule`).
 * Build A3 : Prometheus metrics (`MetricsModule` — registry + endpoint +
 *            HTTP interceptor + BullMQ listener).
 * Build B  : Alerting Discord (`AlertingModule` — @Global, no-op si désactivé).
 *            BullBoard et OpenTelemetry sont enregistrés directement dans
 *            `app.module.ts` (BullBoard conditionnel sur flag, OTel pre-bootstrap).
 */

import { Module } from '@nestjs/common'

import { AlertingModule } from './alerting/alerting.module'
import { MetricsModule } from './metrics/metrics.module'
import { SentryModule } from './sentry/sentry.module'

@Module({
  imports: [SentryModule, MetricsModule, AlertingModule],
  exports: [SentryModule, MetricsModule, AlertingModule],
})
export class ObservabilityModule {}
