/**
 * PRD-004 Ticket 4.2 — `TransferRetryProcessor` (consumer BullMQ).
 *
 * Wrapper *fin* autour de `OutboundTransferService.retryFromJob()` :
 *  - extrait `transferId` + `attempt` du payload (clean, pas de PII),
 *  - restore le trace context OTel via `runWithExtractedTraceContext`,
 *  - délègue 100 % de la logique métier à `OutboundTransferService`
 *    (qui décide retry / FAILED terminal en fonction de `Transfer.retryCount`
 *    + classification de l'erreur Stripe).
 *
 * Pas de side-effect métier dans ce fichier — toute mutation DB / Stripe
 * passe par le service. Cela respecte la séparation Controller/Processor/
 * Service exigée par la rule architecte-api.
 *
 * Pourquoi `attempts: 1` dans le producer + `OnWorkerEvent('failed')` ici ?
 *  - Politique de retry **applicative** (DB-driven, déterministe).
 *  - BullMQ ne sert qu'à délayer & dispatcher.
 *  - Le `failed` event sert uniquement au logging + métrique observabilité
 *    (le caller métier a déjà persisté l'état + alerté).
 */

import { hostname } from 'node:os'

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'

import { runWithExtractedTraceContext } from '../../observability/tracing/bullmq-trace'

import { OutboundTransferService } from './outbound-transfer.service'
import type { TransferRetryJobPayload } from './transfer-retry.queue'
import { TRANSFER_RETRY_JOB, TRANSFER_RETRY_QUEUE } from './transfer.constants'

const WORKER_ID = `${hostname()}#${process.pid}`

@Processor(TRANSFER_RETRY_QUEUE)
export class TransferRetryProcessor extends WorkerHost {
  private readonly logger = new Logger(TransferRetryProcessor.name)

  constructor(private readonly outbound: OutboundTransferService) {
    super()
  }

  async process(job: Job<TransferRetryJobPayload>): Promise<void> {
    if (job.name !== TRANSFER_RETRY_JOB) {
      this.logger.warn(
        { jobName: job.name, bullJobId: job.id },
        'transfer-retry.processor.unknown_job_name',
      )
      return
    }
    return runWithExtractedTraceContext(job.data, TRANSFER_RETRY_QUEUE, job.name, async () => {
      const { transferId, attempt } = job.data
      this.logger.log(
        { transferId, attempt, bullJobId: job.id, worker: WORKER_ID },
        'transfer-retry.processor.start',
      )
      // L'`OutboundTransferService` ré-évalue les pré-conditions (KYC,
      // mission state, no concurrent SENT…) et appelle Stripe avec
      // l'idempotency-key déterministe `transfer-mission-<missionId>`.
      // Pas de double payout possible : Stripe rejette toute clé déjà vue.
      await this.outbound.retryFromJob(transferId)
    })
  }

  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<TransferRetryJobPayload> | undefined, err: Error): Promise<void> {
    if (!job) return
    this.logger.warn(
      {
        transferId: job.data.transferId,
        attempt: job.data.attempt,
        bullJobId: job.id,
        err: err.message,
      },
      'transfer-retry.processor.failed',
    )
  }
}
