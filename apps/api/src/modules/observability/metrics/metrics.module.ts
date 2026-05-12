/**
 * MetricsModule (PRD-004 Ticket 4.1 — Build A3).
 *
 * Expose :
 * - `MetricsService` (registry Prometheus + 8 métriques canoniques)
 * - `GET /api/internal/metrics` (protégé Bearer)
 * - `HttpMetricsInterceptor` global (APP_INTERCEPTOR) — observe toutes les
 *   requêtes HTTP traitées par Nest
 * - `BullMqMetricsService` — attache QueueEvents listeners aux 2 queues
 *   (stripe-webhooks, escrow-auto-release) au boot
 *
 * Le module respecte le `METRICS_ENABLED` flag indirectement : si le flag
 * est `false`, le guard refuse toutes les requêtes vers `/metrics`. Les
 * métriques continuent d'être collectées en mémoire mais ne sont jamais
 * exposées (pas de surcharge mesurable côté CPU).
 *
 * Note : le `BullMqMetricsService` se connecte à Redis indépendamment du
 * pool BullMQ existant — `QueueEvents` requiert sa propre connexion (BullMQ
 * pub/sub ne peut pas multiplexer avec le client `Queue`). C'est aligné
 * avec la recommandation BullMQ officielle.
 */

import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'

import { BullMqMetricsService } from './bullmq-metrics.service'
import { HttpMetricsInterceptor } from './http-metrics.interceptor'
import { MetricsController } from './metrics.controller'
import { MetricsService } from './metrics.service'

@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    BullMqMetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
