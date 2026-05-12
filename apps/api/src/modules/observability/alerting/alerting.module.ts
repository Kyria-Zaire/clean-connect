/**
 * PRD-004 Ticket 4.1 (Build B) — Module Alerting.
 *
 * Global pour permettre `@Inject(AlertingService)` partout sans réimport.
 * Cohérent avec `MetricsModule` (lui aussi @Global).
 */

import { Global, Module } from '@nestjs/common'

import { AlertingService } from './alerting.service'

@Global()
@Module({
  providers: [AlertingService],
  exports: [AlertingService],
})
export class AlertingModule {}
