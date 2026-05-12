/**
 * PRD-003 Ticket 3.1 — Processor BullMQ pour `STRIPE_WEBHOOK_QUEUE`.
 *
 * Scope strict 3.1 :
 *  1. Verrou applicatif transactionnel (anti double traitement concurrent)
 *  2. Marquer `processingStatus = PROCESSED` + `processedAt`
 *  3. Aucun routing métier (Tickets 3.2 → 3.5 ajouteront le dispatch domain events)
 *
 * DLQ : sur `failed` (épuisement des `attempts`), une ligne est insérée dans
 * `WebhookDeadLetter`. La ré-exécution manuelle (admin) viendra Ticket 3.5.
 *
 * Idempotence forte :
 * - PK `stripeEventId` → `findUnique` retourne null si event purgé entre-temps.
 * - `UPDATE … WHERE processingStartedAt IS NULL` = lock atomique (race-safe).
 */

import { hostname } from 'node:os'

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'

import { PrismaService } from '../../../common/prisma/prisma.service'
import {
  STRIPE_WEBHOOK_MAX_ATTEMPTS,
  STRIPE_WEBHOOK_PROCESS_JOB,
  STRIPE_WEBHOOK_QUEUE,
} from '../payments.constants'

import type { StripeWebhookJobPayload } from './payments-webhook.service'

const WORKER_ID = `${hostname()}#${process.pid}`

@Processor(STRIPE_WEBHOOK_QUEUE)
export class StripeWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeWebhookProcessor.name)

  constructor(private readonly prisma: PrismaService) {
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
    const { stripeEventId, type, payloadHash } = job.data
    const lockTaken = await this.tryAcquireLock(stripeEventId)
    if (!lockTaken) {
      this.logger.log(
        { stripeEventId, type },
        'stripe.webhook.processor.already_locked_or_processed',
      )
      return
    }

    try {
      await this.markProcessed(stripeEventId)
      this.logger.log(
        { stripeEventId, type, payloadHash: `${payloadHash.slice(0, 12)}…`, worker: WORKER_ID },
        'stripe.webhook.processor.processed',
      )
    } catch (err) {
      await this.markFailed(stripeEventId, err)
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
