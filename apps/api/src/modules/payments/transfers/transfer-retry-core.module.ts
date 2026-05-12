/**
 * PRD-004 Ticket 4.2 — `TransferRetryCoreModule`.
 *
 * Sous-graphe DI MINIMAL pour la file `transfer-retry` :
 *  - `BullModule.registerQueue(TRANSFER_RETRY_QUEUE)`
 *  - `TransferRetryQueueProducer` (post les delayed jobs)
 *
 * Pourquoi un module séparé ? Cf. doc `transfer-retry.queue.ts` : on évite
 * le cycle Nest `OutboundTransferService` ↔ `TransferRetryProcessor` qui
 * avait causé le retrait initial de la file (TODO(debt) PRD-003 Ticket 3.5).
 *
 * Le processor `TransferRetryProcessor` reste enregistré dans
 * `PaymentsModule` (il dépend d'`OutboundTransferService`).
 */

import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { TransferRetryQueueProducer } from './transfer-retry.queue'
import { TRANSFER_RETRY_QUEUE } from './transfer.constants'

@Module({
  imports: [
    BullModule.registerQueue({
      name: TRANSFER_RETRY_QUEUE,
      defaultJobOptions: {
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
      },
    }),
  ],
  providers: [TransferRetryQueueProducer],
  exports: [TransferRetryQueueProducer],
})
export class TransferRetryCoreModule {}
