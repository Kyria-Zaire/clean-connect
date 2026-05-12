/**
 * PRD-004 Ticket 4.2 — Producer côté file `TRANSFER_RETRY_QUEUE`.
 *
 * Pourquoi un service séparé d'`OutboundTransferService` ?
 *  - L'`OutboundTransferService` lit/écrit la DB + appelle Stripe → grosses
 *    dépendances Nest (Prisma, StripeMetricsTracker, MissionsRepository).
 *  - Le processor de retry réinjecte `OutboundTransferService` → cycle DI si
 *    le producer est aussi dans `OutboundTransferService`. La solution
 *    historique avait été de **désactiver la queue** (cf. TODO(debt) du
 *    Build 3.5). On la réactive proprement via un producer isolé.
 *
 * Pattern : analogue à `AutoReleaseCoreModule` (sous-graphe DI minimaliste).
 *
 * Le service expose :
 *  - `enqueue(opts)` : poste un delayed job BullMQ avec backoff + jitter.
 *    BullMQ déduplique sur `jobId` déterministe = `transfer-retry-<id>-a<n>`.
 *  - `attempts: 1` côté BullMQ : la **politique de retry est applicative**
 *    (DB-driven via `Transfer.retryCount`), pas Bull. Cela évite la double
 *    politique (Bull + service). BullMQ ne sert qu'à délayer + dispatcher.
 *
 * Sécurité :
 *  - Payload `{ transferId }` uniquement — aucune PII (rule observabilité).
 *  - Trace context OTel injecté automatiquement (`injectTraceContext`).
 */

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { applyJitter } from '../../observability/metrics/retry-backoff'
import { injectTraceContext } from '../../observability/tracing/bullmq-trace'

import {
  TRANSFER_RETRY_BACKOFF_MS,
  TRANSFER_RETRY_JOB,
  TRANSFER_RETRY_QUEUE,
  buildTransferRetryBullJobId,
} from './transfer.constants'

export interface TransferRetryJobPayload {
  /** PK `Transfer.id` — le worker re-fetche tout depuis la DB. */
  transferId: string
  /** Compteur applicatif — sert au logging + déterminisme `jobId`. */
  attempt: number
}

@Injectable()
export class TransferRetryQueueProducer {
  private readonly logger = new Logger(TransferRetryQueueProducer.name)

  constructor(
    @InjectQueue(TRANSFER_RETRY_QUEUE)
    private readonly queue: Queue<TransferRetryJobPayload>,
  ) {}

  /**
   * Calcule le délai du `attempt`-ème retry (1-indexed) — borné au dernier
   * palier du backoff. Applique un jitter ± 10 % (anti retry-storm).
   *
   * @param attempt 1 = 1er retry post-échec initial.
   */
  computeDelayMs(attempt: number): number {
    const idx = Math.min(Math.max(0, attempt - 1), TRANSFER_RETRY_BACKOFF_MS.length - 1)
    const base = TRANSFER_RETRY_BACKOFF_MS[idx] as number
    return applyJitter({ delayMs: base })
  }

  /**
   * Poste le job retry. Idempotent côté BullMQ via `jobId` déterministe
   * (`transfer-retry-<id>-a<n>`). Un second `add()` avec le même `jobId` est
   * un no-op silencieux.
   *
   * Aucun throw côté caller : si Redis est down, on log un warn et on rend
   * la main. Le cron `TransferReconcileScheduler` rattrappera les transfers
   * `RETRY_SCHEDULED` orphelins (sans job Bull) au prochain tick.
   */
  async enqueue(opts: { transferId: string; attempt: number }): Promise<void> {
    const delayMs = this.computeDelayMs(opts.attempt)
    const bullJobId = buildTransferRetryBullJobId(opts.transferId, opts.attempt)
    try {
      await this.queue.add(
        TRANSFER_RETRY_JOB,
        injectTraceContext({ transferId: opts.transferId, attempt: opts.attempt }),
        {
          jobId: bullJobId,
          delay: delayMs,
          // CTO : retry policy applicative (DB-driven), pas Bull → 1 seul essai
          // par job posté. L'échec du worker est tracé en DB + alerte.
          attempts: 1,
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
          // On garde les échecs 30 jours pour debug ops (rule createur-workflow).
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        },
      )
      this.logger.log(
        { transferId: opts.transferId, attempt: opts.attempt, bullJobId, delayMs },
        'transfer-retry.queue.enqueued',
      )
    } catch (err) {
      this.logger.warn(
        {
          transferId: opts.transferId,
          attempt: opts.attempt,
          err: err instanceof Error ? err.message : 'unknown',
        },
        'transfer-retry.queue.enqueue_failed',
      )
    }
  }
}
