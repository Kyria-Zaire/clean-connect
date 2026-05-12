/**
 * PRD-003 Ticket 3.4 — `MissionPhotoQuotaService`.
 *
 * Petit service utilitaire qui interroge la table `photos` pour vérifier
 * les quotas BEFORE/AFTER (≥ 3 / ≥ 5) requis pour la transition
 * `ACCEPTED → CLIENT_VALIDATION_PENDING` ET pour les invariants
 * `canReleaseEscrow` côté auto-release executor.
 *
 * Source de vérité : `PHOTO_MIN_BEFORE` / `PHOTO_MIN_AFTER` exportés par
 * `@cc/shared-types`. Une photo « comptée » est une photo dont `syncedAt`
 * est non-null **et** `deletedAt` est null (rétention RGPD non purgée).
 */

import { PHOTO_MIN_AFTER, PHOTO_MIN_BEFORE } from '@cc/shared-types'
import { Injectable } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'

export interface PhotoQuotaReport {
  beforeCount: number
  afterCount: number
  isComplete: boolean
  reason: 'OK' | 'INSUFFICIENT_BEFORE' | 'INSUFFICIENT_AFTER'
}

@Injectable()
export class MissionPhotoQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async check(missionId: string): Promise<PhotoQuotaReport> {
    // Deux `count` Prisma — plus rapide qu'un groupBy pour 2 lignes.
    // On ne dédoublonne pas par `captureClientUuid` (la contrainte UNIQUE
    // `(missionId, captureClientUuid, variant)` garantit déjà 1 photo par
    // capture-variant). On compte ici **variant DISPLAY** uniquement pour
    // ne pas double-compter la paire ORIGINAL+DISPLAY d'une même capture.
    const [beforeCount, afterCount] = await Promise.all([
      this.prisma.photo.count({
        where: {
          missionId,
          type: 'BEFORE',
          variant: 'DISPLAY',
          syncedAt: { not: null },
          deletedAt: null,
        },
      }),
      this.prisma.photo.count({
        where: {
          missionId,
          type: 'AFTER',
          variant: 'DISPLAY',
          syncedAt: { not: null },
          deletedAt: null,
        },
      }),
    ])

    if (beforeCount < PHOTO_MIN_BEFORE) {
      return {
        beforeCount,
        afterCount,
        isComplete: false,
        reason: 'INSUFFICIENT_BEFORE',
      }
    }
    if (afterCount < PHOTO_MIN_AFTER) {
      return {
        beforeCount,
        afterCount,
        isComplete: false,
        reason: 'INSUFFICIENT_AFTER',
      }
    }
    return { beforeCount, afterCount, isComplete: true, reason: 'OK' }
  }
}
