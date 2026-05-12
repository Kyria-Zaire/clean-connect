/**
 * DlqMetricsTracker — instrumentation cycle de vie DLQ.
 * Source de vérité : cahier CTO PRD-004 §A3-bis + Ticket 4.2.
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
 *
 * PRD-004 Ticket 4.2 — Alerting `dlq_growth` P1 :
 *  - À chaque `recordEnqueued`, on émet une alerte P1 `dlq_growth`.
 *  - Le cooldown anti-spam de `AlertingService` (5 min par défaut) évite
 *    de saturer Discord en cas de pic. Une seule alerte par fenêtre.
 *  - Le caller (processor / service) reste maître de la sémantique :
 *    `recordEnqueued` ≡ « une entrée DLQ vient d'apparaître ».
 *  - `emit()` est non-bloquant et ne throw jamais (contrat AlertingService).
 */

import { Injectable } from '@nestjs/common'

import { AlertingService } from '../alerting/alerting.service'

import { MetricsService } from './metrics.service'

export const DLQ_SOURCES = ['stripe'] as const
export type DlqSource = (typeof DLQ_SOURCES)[number]

export const DLQ_ACTIONS = ['enqueued', 'replayed', 'replay_failed'] as const
export type DlqAction = (typeof DLQ_ACTIONS)[number]

@Injectable()
export class DlqMetricsTracker {
  constructor(
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
  ) {}

  recordEnqueued(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'enqueued' })
    // PRD-004 Ticket 4.2 — alerte P1 immédiate avec cooldown (5 min).
    // Aucune PII : on ne passe pas d'event ID, juste source + counter.
    void this.alerting.emit({
      severity: 'P1',
      kind: 'dlq_growth',
      title: `Dead-letter queue growth (${source})`,
      description:
        'A new job has been pushed to the dead-letter queue. Investigate retries / poison / persistent Stripe error.',
      context: { source },
    })
  }

  recordReplayed(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'replayed' })
  }

  recordReplayFailed(source: DlqSource): void {
    this.metrics.dlqEventsTotal.inc({ source, action: 'replay_failed' })
  }
}
