/**
 * DlqMetricsTracker — instrumentation cycle de vie DLQ.
 * Source de vérité : cahier CTO PRD-004 §A3-bis.
 *
 * Métrique alimentée :
 *  - `cleanconnect_dlq_events_total{source, action}` — counter
 *
 * Complète la **gauge** `cleanconnect_dlq_jobs_total{queue}` (déjà branchée
 * par `BullMqMetricsService` en A3 — taille courante de la DLQ).
 *
 * Décision senior : counter (events) + gauge (taille) sont deux concepts
 * orthogonaux. La gauge est utile pour les seuils statiques (`> 10 →
 * page`), le counter pour les rate alerts (`rate(...[5m]) > 0.1`).
 *
 * **Labels autorisés uniquement** : `source` + `action`.
 *  - `source` ∈ {stripe, ...} — provider du job DLQ-ifié.
 *  - `action` ∈ {enqueued, replayed, replay_failed} — type d'événement.
 *
 * Aucun PII (pas d'event ID, pas de payload).
 */

import { Injectable } from '@nestjs/common'

import { MetricsService } from './metrics.service'

export const DLQ_SOURCES = ['stripe'] as const
export type DlqSource = (typeof DLQ_SOURCES)[number]

export const DLQ_ACTIONS = ['enqueued', 'replayed', 'replay_failed'] as const
export type DlqAction = (typeof DLQ_ACTIONS)[number]

@Injectable()
export class DlqMetricsTracker {
  constructor(private readonly metrics: MetricsService) {}

  recordEnqueued(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'enqueued' })
  }

  recordReplayed(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'replayed' })
  }

  recordReplayFailed(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'replay_failed' })
  }
}
