/**
 * Barrel — module Observability (PRD-004 Ticket 4.1).
 *
 * Build A1 : Sentry.
 * Build A2 : Pino hardening (pas de module ici, géré côté `app.module.ts`).
 * Build A3 : Prometheus metrics (ajout `MetricsModule`).
 */

import { Module } from '@nestjs/common'

import { SentryModule } from './sentry/sentry.module'

@Module({
  imports: [SentryModule],
  exports: [SentryModule],
})
export class ObservabilityModule {}
