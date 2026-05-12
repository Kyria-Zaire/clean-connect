/**
 * MetricsModule (PRD-004 Ticket 4.1 — Build A3 + A3-bis).
 *
 * Expose :
 * - `MetricsService` (registry Prometheus — métriques canoniques A3+A3-bis)
 * - `GET /api/internal/metrics` (protégé Bearer)
 * - `HttpMetricsInterceptor` global (APP_INTERCEPTOR) — observe toutes les
 *   requêtes HTTP traitées par Nest
 * - `BullMqMetricsService` — attache QueueEvents listeners aux 2 queues
 *   (stripe-webhooks, escrow-auto-release) au boot
 * - `StripeMetricsTracker` (A3-bis) — wrap les appels SDK Stripe
 * - `WebhookMetricsTracker` (A3-bis) — outcomes ingestion + processor
 * - `DlqMetricsTracker` (A3-bis) — événements cycle de vie DLQ
 *
 * Module `@Global()` : les trackers sont injectés dans plusieurs modules
 * (Payments, MissionsCompletion) sans avoir à importer `MetricsModule`
 * dans chaque cible. Choix justifié — un seul provider singleton de
 * métriques pour tout l'API, conforme ADR-014 (registry unique).
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

import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'

import { BullMqMetricsService } from './bullmq-metrics.service'
import { DlqMetricsTracker } from './dlq-metrics.tracker'
import { HttpMetricsInterceptor } from './http-metrics.interceptor'
import { MetricsController } from './metrics.controller'
import { MetricsService } from './metrics.service'
import { RetryMetricsTracker } from './retry-metrics.tracker'
import { StripeMetricsTracker } from './stripe-metrics.tracker'
import { WebhookMetricsTracker } from './webhook-metrics.tracker'

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    BullMqMetricsService,
    StripeMetricsTracker,
    WebhookMetricsTracker,
    DlqMetricsTracker,
    RetryMetricsTracker,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
  ],
  exports: [
    MetricsService,
    StripeMetricsTracker,
    WebhookMetricsTracker,
    DlqMetricsTracker,
    RetryMetricsTracker,
  ],
})
export class MetricsModule {}
