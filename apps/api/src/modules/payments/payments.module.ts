/**
 * PRD-003 + PRD-004 — `PaymentsModule` (Tickets 3.1 → 3.5 + 4.2).
 *
 * Périmètre :
 *  - Intent client (`POST /v1/payments/intent`) + admin listing.
 *  - Webhooks Stripe (`POST /v1/webhooks/stripe`) — ingestion + DLQ replay.
 *  - Domain handlers (PaymentIntent / Transfer / Refund).
 *  - Outbound transfers Stripe (capture → transfer) + reconcile cron.
 *  - **PRD-004 Ticket 4.2** : retry automatique transfer via
 *    `TransferRetryCoreModule` (file BullMQ isolée).
 *  - Admin refunds + DLQ controllers.
 *
 * DI :
 *  - `PaymentsRepository` EST exporté — `AutoReleaseExecutor`
 *    (`MissionsCompletionModule`) l'injecte. Sans export explicite, Nest
 *    boucle sur `getInstanceByContextId` au lieu d'afficher une erreur
 *    de dépendance claire (audit Verify bisect bootstrap).
 *  - `AutoReleaseCoreModule` ré-importé ici (sans `MissionsCompletionModule`)
 *    pour rompre le cycle Payments ↔ Completion : `PaymentDomainHandler`
 *    cancel le job auto-release sur `payment_intent.succeeded`.
 *  - `TransferRetryCoreModule` : sous-graphe DI MINIMAL avec uniquement la
 *    file `transfer-retry` + `TransferRetryQueueProducer`. Le processor
 *    `TransferRetryProcessor` reste dans `PaymentsModule` (il injecte
 *    `OutboundTransferService`). Cette séparation évite le cycle Nest
 *    historique entre producer (dans `OutboundTransferService`) et processor.
 *  - `ScheduleModule.forRoot()` activé au niveau global via le 1er import —
 *    `TransferReconcileScheduler` utilise `@Cron`.
 *  - `BullModule.registerQueue(STRIPE_WEBHOOK_QUEUE)` — file d'ingestion.
 *
 * Dette PRD-003 résolue en PRD-004 Ticket 4.2 :
 *  - ✅ `TRANSFER_RETRY_QUEUE` Bull réactivé via `TransferRetryCoreModule`.
 *    Retry automatique avec backoff 5min/15min/1h/6h/24h + jitter ± 10 %.
 *    Retry admin manuel reste disponible (`POST /v1/admin/transfers/:id/retry`).
 */

import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { AuthModule } from '../auth/auth.module'
import { MissionsModule } from '../missions/missions.module'
import { AutoReleaseCoreModule } from '../missions-completion/auto-release/auto-release-core.module'

import { AdminPaymentsController } from './admin-payments.controller'
import { AdminRefundsAndDlqController } from './admin-refunds-dlq.controller'
import { AdminTransfersController } from './admin-transfers.controller'
import { STRIPE_WEBHOOK_QUEUE } from './payments.constants'
import { PaymentsController } from './payments.controller'
import { PaymentsRepository } from './payments.repository'
import { PaymentsService } from './payments.service'
import { RefundsRepository } from './refunds/refunds.repository'
import { RefundsService } from './refunds/refunds.service'
import { StripeClientFactory, STRIPE_CLIENT_TOKEN } from './stripe/stripe.client'
import { OutboundTransferService } from './transfers/outbound-transfer.service'
import { TransferReconcileScheduler } from './transfers/transfer-reconcile.scheduler'
import { TransferRetryCoreModule } from './transfers/transfer-retry-core.module'
import { TransferRetryProcessor } from './transfers/transfer-retry.processor'
import { TransfersRepository } from './transfers/transfers.repository'
import { PaymentDomainHandler } from './webhooks/payment-domain.handler'
import { PaymentsWebhookController } from './webhooks/payments-webhook.controller'
import { PaymentsWebhookService } from './webhooks/payments-webhook.service'
import { RefundDomainHandler } from './webhooks/refund-domain.handler'
import { StripeWebhookProcessor } from './webhooks/stripe-webhook.processor'
import { TransferDomainHandler } from './webhooks/transfer-domain.handler'

@Module({
  imports: [
    AuthModule,
    MissionsModule,
    AutoReleaseCoreModule,
    TransferRetryCoreModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: STRIPE_WEBHOOK_QUEUE,
      defaultJobOptions: {
        removeOnFail: false,
      },
    }),
  ],
  controllers: [
    PaymentsController,
    PaymentsWebhookController,
    AdminPaymentsController,
    AdminTransfersController,
    AdminRefundsAndDlqController,
  ],
  providers: [
    StripeClientFactory,
    {
      provide: STRIPE_CLIENT_TOKEN,
      useFactory: (factory: StripeClientFactory) => factory.build(),
      inject: [StripeClientFactory],
    },
    PaymentsRepository,
    PaymentsService,
    PaymentsWebhookService,
    StripeWebhookProcessor,
    PaymentDomainHandler,
    TransferDomainHandler,
    RefundDomainHandler,
    TransfersRepository,
    OutboundTransferService,
    TransferReconcileScheduler,
    TransferRetryProcessor,
    RefundsRepository,
    RefundsService,
  ],
  exports: [
    StripeClientFactory,
    PaymentsRepository,
    PaymentsService,
    PaymentsWebhookService,
    OutboundTransferService,
    TransfersRepository,
    RefundsRepository,
    RefundsService,
  ],
})
export class PaymentsModule {}
