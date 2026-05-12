/**
 * PRD-004 Ticket 4.2 — `PhotoUploadSessionCleanupScheduler`.
 *
 * Orphan cleanup quotidien des `PhotoUploadSession` expirées + jamais
 * consommées + sans `Photo` rattachée. Risque faible (DB only, pas de
 * suppression Cloudinary — dette explicite Ticket 4.4 RGPD).
 *
 * Politique :
 *  - Cron `@Cron('15 4 * * *')` — quotidien 04:15 UTC (charge minimale).
 *  - Buffer 1h après expiration (anti race avec confirms en cours de
 *    réseau lent).
 *  - Limit 500 lignes par tick (borne charge DB).
 *  - Métrique : `cleanconnect_bullmq_retry_exhausted_total` n'est PAS
 *    incrémentée ici (le cleanup n'a pas de notion de "retry exhausted").
 *
 * Sécurité :
 *  - Aucune suppression de `Photo` (les rows consumées = preuves légales,
 *    rétention 12 mois post mission).
 *  - Aucune suppression d'asset Cloudinary (risque réel : on garde la
 *    photo orpheline tant que le cleanup Cloudinary signed-deletes n'est
 *    pas livré en Ticket 4.4.5).
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PhotosRepository } from './photos.repository'

/** Buffer après expiration avant cleanup (anti race confirm tardif). */
export const PHOTO_SESSION_CLEANUP_BUFFER_MS = 60 * 60 * 1_000

/** Borne par tick — évite de bloquer la DB sur un backlog. */
export const PHOTO_SESSION_CLEANUP_LIMIT = 500

@Injectable()
export class PhotoUploadSessionCleanupScheduler {
  private readonly logger = new Logger(PhotoUploadSessionCleanupScheduler.name)

  constructor(private readonly photos: PhotosRepository) {}

  /** Quotidien 04:15 UTC. */
  @Cron('15 4 * * *')
  async runDailyCleanup(): Promise<void> {
    await this.tickInternal(new Date())
  }

  /**
   * Exposé pour tests integration / opération manuelle (DLQ replay admin
   * scripts éventuels).
   */
  async tickInternal(now: Date): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - PHOTO_SESSION_CLEANUP_BUFFER_MS)
    this.logger.log({ cutoff: cutoff.toISOString() }, 'photo-session.cleanup.start')
    const deleted = await this.photos.deleteExpiredUnconsumedSessions({
      olderThan: cutoff,
      limit: PHOTO_SESSION_CLEANUP_LIMIT,
    })
    this.logger.log({ deleted }, 'photo-session.cleanup.done')
    return { deleted }
  }
}
