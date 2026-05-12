/**
 * PRD-004 Ticket 4.2 — Façade typée pour la métrique
 * `cleanconnect_bullmq_retry_exhausted_total{queue, job_type, reason}`.
 *
 * Pourquoi un tracker dédié plutôt qu'incrémenter directement ?
 *  - Source de vérité unique pour la **normalisation des labels** (queue,
 *    job_type, reason). Toute incrémentation passe par ici → pas de
 *    cardinalité non bornée possible.
 *  - Tests : le tracker est mockable, le `MetricsService` ne l'est pas
 *    directement (singleton Registry).
 *
 * Cardinalité maximale = nb queues × nb job_types × nb reasons.
 *  - queues : `stripe-webhooks`, `escrow-auto-release`, `transfer-retry`,
 *    `photo-upload-cleanup` (4).
 *  - job_types : slug applicatif court (`stripe_webhook`,
 *    `escrow_auto_release`, `transfer_payout`, `photo_session_cleanup`).
 *  - reasons : `transient_max_attempts`, `permanent_error`, `stalled_loop`,
 *    `manual_admin_dlq`, `unknown` (5 max).
 *
 * → cardinalité bornée 4 × ~5 × 5 = ~100 séries. Sous le seuil Prometheus.
 */

import { Injectable } from '@nestjs/common'

import { MetricsService } from './metrics.service'

/** Slugs `job_type` autorisés — extensions futures à ajouter explicitement. */
export const RETRY_EXHAUSTED_JOB_TYPES = [
  'stripe_webhook',
  'escrow_auto_release',
  'transfer_payout',
  'photo_session_cleanup',
] as const
export type RetryExhaustedJobType = (typeof RETRY_EXHAUSTED_JOB_TYPES)[number]

/** Slugs `reason` normalisés. */
export const RETRY_EXHAUSTED_REASONS = [
  'transient_max_attempts',
  'permanent_error',
  'stalled_loop',
  'manual_admin_dlq',
  'unknown',
] as const
export type RetryExhaustedReason = (typeof RETRY_EXHAUSTED_REASONS)[number]

@Injectable()
export class RetryMetricsTracker {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Incrémente le compteur d'exhaustion. Appelé une **seule fois** par
   * job qui passe en état terminal d'échec (FAILED définitif, DLQ).
   *
   * Idempotence côté caller obligatoire : si le caller peut être rejoué
   * (replay admin, cron safety-net), il doit vérifier qu'il n'incrémente
   * pas plusieurs fois pour le même job (sinon double comptage).
   */
  recordExhausted(opts: {
    queue: string
    jobType: RetryExhaustedJobType
    reason: RetryExhaustedReason
  }): void {
    this.metrics.bullmqRetryExhaustedTotal.inc({
      queue: opts.queue,
      job_type: opts.jobType,
      reason: opts.reason,
    })
  }
}
