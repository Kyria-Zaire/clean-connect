/**
 * PRD-003 Ticket 3.4 — `AutoReleaseExecutor`.
 *
 * Logique métier d'un run d'auto-release, **découplée** du runtime BullMQ
 * pour permettre :
 *  - Tests unitaires sans Redis (`AutoReleaseProcessor` se contente
 *    d'appeler `executor.run({ ... })`).
 *  - Réutilisation par un cron safety-net horaire (Ticket 3.5) — même
 *    contrôle d'invariants + même verrou applicatif.
 *
 * Cycle d'un run :
 *   1. Lookup `AutoReleaseJob` par `id` (payload BullMQ).
 *   2. **Acquisition du verrou applicatif** (`tryAcquireLockTx`) :
 *        - 1 row → on a pris le job (status devient `RUNNING`).
 *        - 0 row → job déjà CANCELLED/COMPLETED/FAILED ou autre worker en cours.
 *          Sortie idempotente : on ne fait rien.
 *   3. Re-validation des invariants `canReleaseEscrow` (Mission, Payment,
 *      Photos) — défense en profondeur même si `cancel` a été déclenché
 *      hors transaction.
 *   4. Audit `AUTO_RELEASE_STARTED` + `AUTO_RELEASE_TRIGGERED` (ou
 *      `AUTO_RELEASE_BLOCKED` si invariants KO).
 *   5. Appel `PaymentsService.requestCapture(missionId, { kind: SYSTEM,
 *      trigger: AUTO_RELEASE })` — idempotent côté Stripe.
 *   6. Sur succès → `markCompletedTx` (mission `CLIENT_VALIDATION_PENDING
 *      → COMPLETED` arrive ensuite via webhook `payment_intent.succeeded`).
 *   7. Sur erreur Stripe → `markFailedTx` + retry BullMQ via backoff
 *      exponentiel (3 essais — cf. constants). Au 3ᵉ échec → DLQ Ticket 3.5.
 *
 * **Important** : on NE transitionne PAS la mission vers COMPLETED ici.
 * C'est le webhook `payment_intent.succeeded` qui le fait, garantissant
 * que `Payment.status` et `Mission.status` sont toujours cohérents.
 */

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common'
import type { AutoReleaseJob } from '@prisma/client'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { MissionsRepository } from '../../missions/missions.repository'
import { MissionEventService } from '../../missions/services/mission-event.service'
import {
  PaymentAuthorizationExpiredException,
  PaymentNotCapturableException,
} from '../../payments/payments.errors'
import { PaymentsRepository } from '../../payments/payments.repository'
import { PaymentsService } from '../../payments/payments.service'
import { MissionPhotoQuotaService } from '../photo-quota.service'

import { AutoReleaseJobRepository } from './auto-release.repository'

export interface AutoReleaseRunInput {
  autoReleaseJobId: string
  missionId: string
  workerId: string
}

export type AutoReleaseRunResult =
  | { outcome: 'COMPLETED'; reason: 'CAPTURE_REQUESTED' }
  | { outcome: 'SKIPPED'; reason: 'LOCK_NOT_ACQUIRED' | 'JOB_NOT_FOUND' | 'JOB_TERMINAL' }
  | { outcome: 'BLOCKED'; reason: AutoReleaseBlockedReason }
  | { outcome: 'FAILED'; reason: string }

export type AutoReleaseBlockedReason =
  | 'MISSION_NOT_FOUND'
  | 'MISSION_STATE_NOT_CLIENT_VALIDATION_PENDING'
  | 'PAYMENT_NOT_AUTHORIZED'
  | 'PAYMENT_AUTHORIZATION_EXPIRED'
  | 'PHOTOS_INSUFFICIENT'

@Injectable()
export class AutoReleaseExecutor {
  private readonly logger = new Logger(AutoReleaseExecutor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: AutoReleaseJobRepository,
    private readonly missions: MissionsRepository,
    private readonly payments: PaymentsRepository,
    private readonly missionEvents: MissionEventService,
    private readonly photoQuota: MissionPhotoQuotaService,
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
  ) {}

  async run(input: AutoReleaseRunInput): Promise<AutoReleaseRunResult> {
    const job = await this.jobs.findById(input.autoReleaseJobId)
    if (!job) {
      this.logger.warn(
        { autoReleaseJobId: input.autoReleaseJobId },
        'auto-release.run.job_not_found',
      )
      return { outcome: 'SKIPPED', reason: 'JOB_NOT_FOUND' }
    }
    if (job.status === 'CANCELLED' || job.status === 'COMPLETED' || job.status === 'FAILED') {
      this.logger.log(
        { autoReleaseJobId: job.id, status: job.status },
        'auto-release.run.terminal_skip',
      )
      return { outcome: 'SKIPPED', reason: 'JOB_TERMINAL' }
    }

    const now = new Date()
    const lockTaken = await this.prisma.$transaction((tx) =>
      this.jobs.tryAcquireLockTx(tx, {
        jobId: job.id,
        lockedBy: input.workerId,
        now,
      }),
    )
    if (lockTaken !== 1) {
      this.logger.log(
        { autoReleaseJobId: job.id, workerId: input.workerId },
        'auto-release.run.lock_not_acquired',
      )
      return { outcome: 'SKIPPED', reason: 'LOCK_NOT_ACQUIRED' }
    }

    // Audit "STARTED" hors-transaction (idempotent — la mission est déjà
    // marquée RUNNING par tryAcquireLockTx).
    await this.missionEvents.record({
      missionId: input.missionId,
      type: 'AUTO_RELEASE_STARTED',
      actorUserId: null,
      payload: { autoReleaseJobId: job.id, workerId: input.workerId },
    })

    const blocked = await this.checkInvariants(input.missionId)
    if (blocked) {
      await this.handleBlocked(job, blocked)
      return { outcome: 'BLOCKED', reason: blocked }
    }

    return await this.triggerCapture(job, input.missionId)
  }

  /**
   * Revalide tous les invariants `canReleaseEscrow` (Design AC-D.4) :
   *  - Mission existe et est en CLIENT_VALIDATION_PENDING.
   *  - Payment lié existe et est en AUTHORIZED (pas CANCELLED authorization_expired).
   *  - Photos ≥ 3 BEFORE + ≥ 5 AFTER (DISPLAY syncées + non purgées).
   *
   * Renvoie le motif de blocage, ou null si tout est OK.
   */
  private async checkInvariants(missionId: string): Promise<AutoReleaseBlockedReason | null> {
    const mission = await this.missions.findById(missionId)
    if (!mission) return 'MISSION_NOT_FOUND'
    if (mission.status !== 'CLIENT_VALIDATION_PENDING') {
      // Cas légitimes : DISPUTE_OPEN (litige ouvert pendant le délai),
      // COMPLETED (validate client traité avant l'auto-release), CANCELLED.
      return 'MISSION_STATE_NOT_CLIENT_VALIDATION_PENDING'
    }
    const payment = await this.payments.findByMissionId(missionId)
    if (!payment) return 'PAYMENT_NOT_AUTHORIZED'
    if (payment.status === 'CANCELLED' && payment.failureCode === 'authorization_expired') {
      return 'PAYMENT_AUTHORIZATION_EXPIRED'
    }
    if (payment.status !== 'AUTHORIZED' && payment.status !== 'CAPTURED') {
      return 'PAYMENT_NOT_AUTHORIZED'
    }
    const quotas = await this.photoQuota.check(missionId)
    if (!quotas.isComplete) return 'PHOTOS_INSUFFICIENT'
    return null
  }

  private async handleBlocked(
    job: AutoReleaseJob,
    reason: AutoReleaseBlockedReason,
  ): Promise<void> {
    const now = new Date()
    await this.prisma.$transaction(async (tx) => {
      await this.jobs.markFailedTx(tx, {
        jobId: job.id,
        lastError: `BLOCKED:${reason}`,
        now,
      })
      await this.missionEvents.recordTx(tx, {
        missionId: job.missionId,
        type: 'AUTO_RELEASE_BLOCKED',
        actorUserId: null,
        payload: { autoReleaseJobId: job.id, reason },
      })
    })
    this.logger.warn(
      { autoReleaseJobId: job.id, missionId: job.missionId, reason },
      'auto-release.run.blocked',
    )
  }

  private async triggerCapture(
    job: AutoReleaseJob,
    missionId: string,
  ): Promise<AutoReleaseRunResult> {
    try {
      await this.paymentsService.requestCapture(missionId, {
        kind: 'SYSTEM',
        trigger: 'AUTO_RELEASE',
      })
    } catch (err) {
      // PaymentNotCapturable / AuthorizationExpired = invariants à corriger
      // (course race avec validate / canceled). On marque BLOCKED — pas FAILED
      // — pour éviter retry inutile.
      if (
        err instanceof PaymentNotCapturableException ||
        err instanceof PaymentAuthorizationExpiredException
      ) {
        const reason: AutoReleaseBlockedReason =
          err instanceof PaymentAuthorizationExpiredException
            ? 'PAYMENT_AUTHORIZATION_EXPIRED'
            : 'PAYMENT_NOT_AUTHORIZED'
        await this.handleBlocked(job, reason)
        return { outcome: 'BLOCKED', reason }
      }
      // Autre exception (Stripe network / config) → FAILED → retry BullMQ.
      const lastError =
        err instanceof Error ? `${err.name}:${err.message}` : 'unknown_error'
      await this.prisma.$transaction(async (tx) => {
        await this.jobs.markFailedTx(tx, {
          jobId: job.id,
          lastError,
          now: new Date(),
        })
        await this.missionEvents.recordTx(tx, {
          missionId,
          type: 'AUTO_RELEASE_FAILED',
          actorUserId: null,
          payload: { autoReleaseJobId: job.id, errorClass: err instanceof Error ? err.name : 'unknown' },
        })
      })
      this.logger.error(
        {
          autoReleaseJobId: job.id,
          missionId,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'auto-release.run.failed',
      )
      // Re-throw pour que BullMQ programme le retry / DLQ après épuisement.
      throw err
    }

    const now = new Date()
    await this.prisma.$transaction(async (tx) => {
      await this.jobs.markCompletedTx(tx, { jobId: job.id, now })
      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'AUTO_RELEASE_TRIGGERED',
        actorUserId: null,
        payload: { autoReleaseJobId: job.id },
      })
    })
    this.logger.log(
      { autoReleaseJobId: job.id, missionId },
      'auto-release.run.completed',
    )
    return { outcome: 'COMPLETED', reason: 'CAPTURE_REQUESTED' }
  }
}
