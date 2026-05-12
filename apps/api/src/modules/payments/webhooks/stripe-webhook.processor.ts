/**
 * PRD-003 Ticket 3.1 (étendu Ticket 3.2) — Processor BullMQ pour
 * `STRIPE_WEBHOOK_QUEUE`.
 *
 * Pipeline :
 *  1. Verrou applicatif (`UPDATE … WHERE processingStartedAt IS NULL`).
 *  2. Si l'event a un handler métier (`PaymentDomainHandler.shouldHandle`) →
 *     `stripe.events.retrieve(eventId)` pour récupérer le payload AUTHENTIFIÉ
 *     côté Stripe (jamais sourcé depuis Redis — rule securite + audit V1).
 *  3. Routing → handler métier (transitions Payment/Mission + audit + matching).
 *  4. Marquer `processingStatus = PROCESSED`. Events sans handler en 3.2
 *     (transfer.*, charge.refunded, account.updated, etc.) sont marqués
 *     `PROCESSED` sans action métier — leur routing arrive Tickets 3.3 → 3.5.
 *
 * DLQ : sur `failed` (épuisement des `attempts`), insert dans
 * `WebhookDeadLetter`. Ré-exécution admin = Ticket 3.5.
 */

import { hostname } from 'node:os'

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import type Stripe from 'stripe'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { AlertingService } from '../../observability/alerting/alerting.service'
import { DlqMetricsTracker } from '../../observability/metrics/dlq-metrics.tracker'
import { RetryMetricsTracker } from '../../observability/metrics/retry-metrics.tracker'
import { StripeMetricsTracker } from '../../observability/metrics/stripe-metrics.tracker'
import { WebhookMetricsTracker } from '../../observability/metrics/webhook-metrics.tracker'
import { runWithExtractedTraceContext } from '../../observability/tracing/bullmq-trace'
import {
  STRIPE_WEBHOOK_MAX_ATTEMPTS,
  STRIPE_WEBHOOK_PROCESS_JOB,
  STRIPE_WEBHOOK_QUEUE,
} from '../payments.constants'
import { STRIPE_CLIENT_TOKEN } from '../stripe/stripe.client'

import { PaymentDomainHandler } from './payment-domain.handler'
import type { StripeWebhookJobPayload } from './payments-webhook.service'
import { RefundDomainHandler } from './refund-domain.handler'
import { TransferDomainHandler } from './transfer-domain.handler'

const WORKER_ID = `${hostname()}#${process.pid}`

@Processor(STRIPE_WEBHOOK_QUEUE)
export class StripeWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeWebhookProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentDomain: PaymentDomainHandler,
    private readonly transferDomain: TransferDomainHandler,
    private readonly refundDomain: RefundDomainHandler,
    private readonly stripeMetrics: StripeMetricsTracker,
    private readonly webhookMetrics: WebhookMetricsTracker,
    private readonly dlqMetrics: DlqMetricsTracker,
    private readonly retryMetrics: RetryMetricsTracker,
    private readonly alerting: AlertingService,
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe: Stripe,
  ) {
    super()
  }

  async process(job: Job<StripeWebhookJobPayload>): Promise<void> {
    if (job.name !== STRIPE_WEBHOOK_PROCESS_JOB) {
      this.logger.warn(
        { jobName: job.name },
        'stripe.webhook.processor.unknown_job_name',
      )
      return
    }
    // PRD-004 Build B — restore trace context HTTP → worker (no-op si OTel SDK off).
    return runWithExtractedTraceContext(
      job.data,
      STRIPE_WEBHOOK_QUEUE,
      job.name,
      () => this.processImpl(job),
    )
  }

  private async processImpl(job: Job<StripeWebhookJobPayload>): Promise<void> {
    const { stripeEventId, type, payloadHash } = job.data
    const processStart = process.hrtime.bigint()
    const lockTaken = await this.tryAcquireLock(stripeEventId)
    if (!lockTaken) {
      this.logger.log(
        { stripeEventId, type },
        'stripe.webhook.processor.already_locked_or_processed',
      )
      // No outcome metric here : c'est un cas légitime (concurrent worker /
      // déjà processed). On évite de polluer `webhook_processing_total` —
      // l'event original a déjà été comptabilisé `accepted` à l'ingestion.
      return
    }

    const shouldRoute =
      this.paymentDomain.shouldHandle(type) ||
      this.transferDomain.shouldHandle(type) ||
      this.refundDomain.shouldHandle(type)

    try {
      if (!shouldRoute) {
        await this.markProcessed(stripeEventId)
        this.logger.log(
          {
            stripeEventId,
            type,
            payloadHash: `${payloadHash.slice(0, 12)}…`,
            worker: WORKER_ID,
            routed: false,
          },
          'stripe.webhook.processor.processed_no_domain_route',
        )
        this.webhookMetrics.observe(type, 'accepted', durationSecondsSince(processStart))
        return
      }

      const event = await this.stripeMetrics.time('events.retrieve', () =>
        this.stripe.events.retrieve(stripeEventId),
      )
      if (this.paymentDomain.shouldHandle(type)) {
        await this.paymentDomain.handle(event)
      }
      if (this.transferDomain.shouldHandle(type)) {
        await this.transferDomain.handle(event)
      }
      if (this.refundDomain.shouldHandle(type)) {
        await this.refundDomain.handle(event)
      }

      await this.markProcessed(stripeEventId)
      this.logger.log(
        {
          stripeEventId,
          type,
          payloadHash: `${payloadHash.slice(0, 12)}…`,
          worker: WORKER_ID,
          routed: true,
        },
        'stripe.webhook.processor.processed',
      )
      this.webhookMetrics.observe(type, 'accepted', durationSecondsSince(processStart))
    } catch (err) {
      await this.markFailed(stripeEventId, err)
      // Outcome `failed` à chaque tentative de processor échouée — c'est
      // intentionnel (visibilité retries dans le compteur). La transition
      // DLQ finale est tracée en plus via `dlq_events_total` ci-dessous.
      this.webhookMetrics.observe(type, 'failed', durationSecondsSince(processStart))
      throw err
    }
  }

  /**
   * Lock atomique : `UPDATE … WHERE stripeEventId=? AND processingStartedAt IS NULL`.
   * Retourne `true` si on a posé le verrou, `false` si :
   *   - un autre worker l'a déjà pris (race BullMQ)
   *   - l'event a déjà été traité (`PROCESSED`)
   *
   * Pas de `FOR UPDATE` ici car l'`UPDATE … WHERE …` est atomique par lui-même
   * sous PostgreSQL (un seul worker remontera `count > 0`).
   */
  private async tryAcquireLock(stripeEventId: string): Promise<boolean> {
    const result = await this.prisma.stripeWebhookEvent.updateMany({
      where: {
        stripeEventId,
        processingStartedAt: null,
        // On accepte PENDING et FAILED (retry après échec transitoire).
        processingStatus: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        processingStatus: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    })
    return result.count === 1
  }

  private async markProcessed(stripeEventId: string): Promise<void> {
    await this.prisma.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        lastError: null,
      },
    })
  }

  private async markFailed(stripeEventId: string, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : 'unknown_error'
    await this.prisma.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        processingStatus: 'FAILED',
        // On relâche le lock pour permettre un retry par un autre worker.
        processingStartedAt: null,
        lastError: errorMessage.slice(0, 2_000),
      },
    })
  }

  /**
   * Si BullMQ a épuisé tous les retries, on bascule en DLQ pour replay manuel
   * admin (Ticket 3.5). `attemptsMade` reflète le compteur BullMQ final.
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<StripeWebhookJobPayload> | undefined, err: Error): Promise<void> {
    if (!job) return
    const attempts = job.attemptsMade
    if (attempts < STRIPE_WEBHOOK_MAX_ATTEMPTS) {
      this.logger.warn(
        { stripeEventId: job.data.stripeEventId, attempts, err: err.message },
        'stripe.webhook.processor.retry_scheduled',
      )
      return
    }

    try {
      await this.prisma.webhookDeadLetter.create({
        data: {
          source: 'STRIPE',
          externalEventId: job.data.stripeEventId,
          payloadHash: job.data.payloadHash,
          errorMessage: err.message.slice(0, 4_000),
          attempts,
          lastAttemptAt: new Date(),
        },
      })
      this.dlqMetrics.recordEnqueued('stripe')
      // PRD-004 Ticket 4.2 — poison job webhook : métrique + alerte P0.
      // CTO : on alerte P0 car un webhook Stripe poison peut bloquer une
      // mission/paiement entier (transfer pas déclenché, payout pas envoyé).
      this.retryMetrics.recordExhausted({
        queue: STRIPE_WEBHOOK_QUEUE,
        jobType: 'stripe_webhook',
        reason: 'transient_max_attempts',
      })
      void this.alerting.emit({
        severity: 'P0',
        kind: 'bullmq_failed_jobs',
        title: `Stripe webhook poison job (${job.data.type})`,
        description: `Webhook ${job.data.stripeEventId.slice(0, 12)}… exhausted ${attempts} attempts. Routed to DLQ. Investigate handler error + manual replay.`,
        context: {
          eventType: job.data.type,
          attempts,
          // ID tronqué — pas d'event ID complet (PII potentielle si chaîné avec autres logs).
          eventIdShort: job.data.stripeEventId.slice(0, 12),
        },
      })
      this.logger.error(
        { stripeEventId: job.data.stripeEventId, attempts, type: job.data.type },
        'stripe.webhook.processor.dead_letter',
      )
    } catch (dlqErr) {
      // Ultime garde-fou : si la DLQ elle-même fail, on log + on remonte rien
      // (pour ne pas masquer l'erreur originale côté BullMQ).
      this.logger.fatal(
        { stripeEventId: job.data.stripeEventId, err: dlqErr instanceof Error ? dlqErr.message : 'unknown' },
        'stripe.webhook.processor.dlq_write_failed',
      )
    }
  }
}

function durationSecondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000_000
}
