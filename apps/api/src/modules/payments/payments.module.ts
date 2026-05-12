/**
 * PRD-003 Ticket 3.1 — PaymentsModule (infra Stripe + ingestion webhook).
 *
 * Le module charge ses dépendances même si `FF_PAYMENTS_ENABLED=false` car Nest
 * exige un graph statique. Le gating se fait :
 *  - au controller : `PaymentsWebhookService.assertEnabled()` lève 503
 *  - au processor  : BullMQ est branché mais ne reçoit aucun job tant que le
 *    controller refuse l'ingestion (donc la queue reste vide ; rien à filtrer
 *    côté worker, qui reste idle).
 *
 * Ce design évite des conditionnels d'import (`if FF then`) qui causent des
 * surprises en mode prod build (Webpack tree-shake les modules dynamiques).
 *
 * Imports clés :
 * - `AuthModule` : pour réutiliser `JwtAccessGuard` global (`@Public()` côté
 *   webhook). Les endpoints Payments futurs (POST /missions/:id/pay, refund,
 *   etc.) en hériteront sans configuration supplémentaire.
 * - `BullModule.registerQueue` : déclaration locale de la queue webhook
 *   (la connection Redis vient de `BullModule.forRootAsync` posé en AppModule).
 */

import { BullModule } from '@nestjs/bullmq'
import { forwardRef, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { MissionsModule } from '../missions/missions.module'
import { MissionsCompletionModule } from '../missions-completion/missions-completion.module'

import { AdminPaymentsController } from './admin-payments.controller'
import { STRIPE_WEBHOOK_QUEUE } from './payments.constants'
import { PaymentsController } from './payments.controller'
import { PaymentsRepository } from './payments.repository'
import { PaymentsService } from './payments.service'
import { StripeClientFactory, STRIPE_CLIENT_TOKEN } from './stripe/stripe.client'
import { PaymentDomainHandler } from './webhooks/payment-domain.handler'
import { PaymentsWebhookController } from './webhooks/payments-webhook.controller'
import { PaymentsWebhookService } from './webhooks/payments-webhook.service'
import { StripeWebhookProcessor } from './webhooks/stripe-webhook.processor'

@Module({
  imports: [
    AuthModule,
    // PRD-003 Ticket 3.2 — réutilise `MissionsRepository` + `MissionEventService`
    // + `MatchingService` (exposés via `MissionsModule.exports`).
    MissionsModule,
    // PRD-003 Ticket 3.4 — `PaymentDomainHandler.onCaptured` (webhook
    // `payment_intent.succeeded`) appelle `AutoReleaseService.cancel`.
    // Cycle inverse : `MissionCompletionService.validate` appelle
    // `PaymentsService.requestCapture`. `forwardRef` côté DI au niveau
    // service + module pour casser le cycle d'évaluation Nest.
    forwardRef(() => MissionsCompletionModule),
    BullModule.registerQueue({
      name: STRIPE_WEBHOOK_QUEUE,
      defaultJobOptions: {
        // Override possible côté `queue.add(…)` (cf. service). On garde un
        // garde-fou global pour ne jamais perdre un job par défaut.
        removeOnFail: false,
      },
    }),
  ],
  controllers: [
    PaymentsWebhookController,
    PaymentsController,
    AdminPaymentsController,
  ],
  providers: [
    StripeClientFactory,
    {
      // PRD-003 Ticket 3.2 — singleton Stripe SDK injecté via token DI
      // (`STRIPE_CLIENT_TOKEN`). Une seule instance partagée par tous les
      // services payments (PaymentsService, PaymentDomainHandler, processor).
      provide: STRIPE_CLIENT_TOKEN,
      useFactory: (factory: StripeClientFactory) => factory.build(),
      inject: [StripeClientFactory],
    },
    PaymentsRepository,
    PaymentsService,
    PaymentDomainHandler,
    PaymentsWebhookService,
    StripeWebhookProcessor,
  ],
  exports: [PaymentsWebhookService, StripeClientFactory, PaymentsService],
})
export class PaymentsModule {}
