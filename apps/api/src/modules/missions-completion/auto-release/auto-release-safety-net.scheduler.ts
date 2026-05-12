/**
 * PRD-004 Ticket 4.2 — `AutoReleaseSafetyNetScheduler`.
 *
 * Cron horaire qui ré-enqueue les `AutoReleaseJob` perdus côté BullMQ (SCHEDULED
 * dépassé) ou bloqués sur un lock applicatif orphelin (RUNNING avec `lockedAt`
 * trop ancien — worker crashé).
 *
 * Politique CTO :
 *  - Cron `@Cron('0 * * * *')` (toutes les heures, à HH:00).
 *  - Si > N jobs bloqués trouvés en une fois → alerte P1 (anomalie).
 *  - Idempotent : BullMQ déduplique sur `jobId` déterministe ; l'executor
 *    revalide tous les invariants métier (`canReleaseEscrow`).
 *
 * Pas dans `AutoReleaseCoreModule` car le scheduler n'a pas besoin de la queue
 * (il appelle `AutoReleaseService` qui l'a déjà). Vit dans
 * `MissionsCompletionModule` (cf. `missions-completion.module.ts`).
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { AlertingService } from '../../observability/alerting/alerting.service'

import { AutoReleaseService } from './auto-release.service'

/** Seuil à partir duquel on émet une alerte P1 (anomalie systémique). */
export const AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD = 10

@Injectable()
export class AutoReleaseSafetyNetScheduler {
  private readonly logger = new Logger(AutoReleaseSafetyNetScheduler.name)

  constructor(
    private readonly autoRelease: AutoReleaseService,
    private readonly alerting: AlertingService,
  ) {}

  /** Toutes les heures, à HH:00. */
  @Cron('0 * * * *')
  async runHourlySafetyNet(): Promise<void> {
    await this.tickInternal(new Date())
  }

  /**
   * Exposé pour tests integration — permet de déclencher le tick à la demande
   * sans attendre l'horloge cron.
   */
  async tickInternal(now: Date): Promise<{
    scanned: number
    relockReleased: number
    reenqueued: number
  }> {
    this.logger.log('auto-release.safety.cron.start')
    const result = await this.autoRelease.reenqueueStuck({ now })
    this.logger.log(result, 'auto-release.safety.cron.done')

    if (result.reenqueued >= AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD) {
      // CTO : si plus de 10 jobs stuck en une heure, c'est anormal. Alerte P1
      // pour investigation ops. Pas P0 — l'auto-release continue de fonctionner
      // grâce au cron, juste plus lentement que prévu.
      void this.alerting.emit({
        severity: 'P1',
        kind: 'auto_release_stalled',
        title: `Auto-release safety-net rescued ${result.reenqueued} stuck jobs`,
        description:
          'Hourly cron found unusually high count of stuck AutoReleaseJobs. Possible Redis loss, worker crash, or BullMQ backlog.',
        context: {
          scanned: result.scanned,
          relockReleased: result.relockReleased,
          reenqueued: result.reenqueued,
          threshold: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD,
        },
      })
    }
    return result
  }
}
