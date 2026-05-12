/**
 * PRD-003 Ticket 3.4 — `AutoReleaseService` (producer côté BullMQ).
 *
 * Responsabilités :
 *  - Planifier un `escrow.auto-release` delayed job à T+48h ouvrées
 *    Europe/Paris au moment où la mission passe en
 *    `CLIENT_VALIDATION_PENDING` (POST /complete).
 *  - Annuler ce job dès qu'une action concurrente le rend caduc :
 *      - CLIENT a validé (`POST /validate`) — capture déjà déclenchée.
 *      - CLIENT a ouvert un litige (`POST /report-problem`) — auto-release
 *        interdit jusqu'à instruction admin (PRD-005).
 *  - Verrouiller atomiquement la ligne `AutoReleaseJob` au démarrage du
 *    worker (audit V10 — défense en profondeur même si BullMQ déduplique
 *    déjà via `jobId` déterministe).
 *
 * Hors-scope 3.4 (Ticket 3.5) :
 *  - Cron horaire safety-net (`escrow.safety-net`) — rejoue les jobs perdus.
 *  - DLQ admin replay UI.
 *  - Orchestration retry après `authorization_expired`.
 */

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import type { AutoReleaseJob, Prisma } from '@prisma/client'
import type { Queue } from 'bullmq'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { injectTraceContext } from '../../observability/tracing/bullmq-trace'

import {
  AUTO_RELEASE_BACKOFF_BASE_MS,
  AUTO_RELEASE_BUSINESS_HOURS,
  AUTO_RELEASE_MAX_ATTEMPTS,
  AUTO_RELEASE_PROCESS_JOB,
  AUTO_RELEASE_QUEUE,
  AUTO_RELEASE_SAFETY_GRACE_MS,
  AUTO_RELEASE_SAFETY_LIMIT,
  AUTO_RELEASE_STUCK_LOCK_MS,
  buildAutoReleaseBullJobId,
  buildCaptureIdempotencyKey,
} from './auto-release.constants'
import { AutoReleaseJobRepository } from './auto-release.repository'
import { addBusinessHoursParis } from './business-hours'

/**
 * Payload BullMQ minimal — pas de PII, pas de secrets Stripe (rule
 * securite + Pino redactor). Le worker re-fetche tout depuis la DB
 * via `autoReleaseJob.id`.
 */
export interface AutoReleaseJobPayload {
  /** Clé primaire `AutoReleaseJob.id` (UUID v4 généré DB). */
  autoReleaseJobId: string
  /** Mission cible — utilisé pour les logs + assertions worker. */
  missionId: string
}

export interface SchedulePlan {
  scheduledFor: Date
  bullJobId: string
  idempotencyKey: string
}

@Injectable()
export class AutoReleaseService {
  private readonly logger = new Logger(AutoReleaseService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: AutoReleaseJobRepository,
    @InjectQueue(AUTO_RELEASE_QUEUE) private readonly queue: Queue<AutoReleaseJobPayload>,
  ) {}

  /**
   * Calcule la date T+48h ouvrées + clés déterministes, sans persister.
   * Permet au caller (`MissionCompletionService`) de loguer/auditer la
   * date prévue avant d'insérer le job en DB.
   */
  computeSchedulePlan(now: Date, missionId: string): SchedulePlan {
    return {
      scheduledFor: addBusinessHoursParis(now, AUTO_RELEASE_BUSINESS_HOURS),
      bullJobId: buildAutoReleaseBullJobId(missionId),
      idempotencyKey: buildCaptureIdempotencyKey(missionId),
    }
  }

  /**
   * Insère la ligne `AutoReleaseJob` (idempotent) + poste le delayed job
   * BullMQ. Doit être appelé **dans la même `$transaction`** que la
   * transition `Mission ACCEPTED → CLIENT_VALIDATION_PENDING` pour
   * garantir l'invariant « toute mission en CLIENT_VALIDATION_PENDING
   * possède un AutoReleaseJob actif » (audit Verify D8).
   *
   * Retourne le job (créé ou existant) + un flag `created` pour permettre
   * au caller de skipper l'appel BullMQ en cas de replay.
   */
  async scheduleTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; now: Date },
  ): Promise<{ job: AutoReleaseJob; plan: SchedulePlan; created: boolean }> {
    const plan = this.computeSchedulePlan(opts.now, opts.missionId)
    const { job, created } = await this.jobs.upsertScheduledTx(tx, {
      missionId: opts.missionId,
      bullJobId: plan.bullJobId,
      idempotencyKey: plan.idempotencyKey,
      scheduledFor: plan.scheduledFor,
    })
    return { job, plan, created }
  }

  /**
   * Poste le delayed job BullMQ. Appelé **après** commit DB (cf. caller).
   * BullMQ déduplique sur `jobId` déterministe (audit V3).
   *
   * Le delay est calculé à partir de `scheduledFor - now`. Si le delay
   * est négatif (cas pathologique : horloge serveur réculée), on poste
   * sans delay (le worker exécutera dès que possible — invariants
   * `canReleaseEscrow` revalidés côté processor).
   */
  async enqueueDelayedJob(opts: {
    autoReleaseJobId: string
    missionId: string
    scheduledFor: Date
    bullJobId: string
    now: Date
  }): Promise<void> {
    const delay = Math.max(0, opts.scheduledFor.getTime() - opts.now.getTime())
    await this.queue.add(
      AUTO_RELEASE_PROCESS_JOB,
      injectTraceContext({
        autoReleaseJobId: opts.autoReleaseJobId,
        missionId: opts.missionId,
      }),
      {
        jobId: opts.bullJobId,
        delay,
        attempts: AUTO_RELEASE_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: AUTO_RELEASE_BACKOFF_BASE_MS },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
        removeOnFail: false,
      },
    )
    this.logger.log(
      {
        missionId: opts.missionId,
        autoReleaseJobId: opts.autoReleaseJobId,
        bullJobId: opts.bullJobId,
        delayMs: delay,
        scheduledFor: opts.scheduledFor.toISOString(),
      },
      'auto-release.queue.scheduled',
    )
  }

  /**
   * Annule la ligne `AutoReleaseJob` + retire le delayed job BullMQ.
   *
   * Idempotent (et tolère un job déjà absent côté BullMQ — ex. déjà
   * exécuté, ou jamais posté car race sur le commit DB initial). Appelé
   * lors de `POST /validate` (reason='client_validated') ou
   * `POST /report-problem` (reason='dispute_opened').
   */
  async cancel(opts: { missionId: string; reason: string }): Promise<{ cancelled: boolean }> {
    const now = new Date()
    const cancelled = await this.prisma.$transaction((tx) =>
      this.jobs.cancelTx(tx, { missionId: opts.missionId, reason: opts.reason, now }),
    )
    if (cancelled === 0) {
      // Job déjà CANCELLED / COMPLETED / FAILED — pas de side-effect (idempotent).
      return { cancelled: false }
    }
    const bullJobId = buildAutoReleaseBullJobId(opts.missionId)
    try {
      const job = await this.queue.getJob(bullJobId)
      if (job) {
        await job.remove()
      }
    } catch (err) {
      // BullMQ peut retourner une erreur si le job est déjà en cours
      // d'exécution (`Job locked` côté Redis). Le worker fera le job
      // de revalidation `canReleaseEscrow` (qui renverra DISPUTE_OPEN ou
      // mission COMPLETED) — pas de panique.
      this.logger.warn(
        {
          missionId: opts.missionId,
          bullJobId,
          err: err instanceof Error ? err.message : 'unknown',
        },
        'auto-release.queue.cancel_remove_failed',
      )
    }
    this.logger.log(
      { missionId: opts.missionId, reason: opts.reason, bullJobId },
      'auto-release.queue.cancelled',
    )
    return { cancelled: true }
  }

  /**
   * PRD-004 Ticket 4.2 — Safety-net cron (AC-4.2.4.1 + AC-4.2.2.1).
   *
   * Appelé par `AutoReleaseSafetyNetScheduler` toutes les heures.
   *
   * Pour chaque job stuck (SCHEDULED dépassé OU RUNNING avec lock orphelin) :
   *  1. Si RUNNING → relâche le lock applicatif (`releaseStuckLockTx`).
   *  2. Calcule un `delay` court (~10s) pour replanifier vite — on a déjà
   *     dépassé `scheduledFor`, plus la peine de re-attendre 48h.
   *  3. Poste un job BullMQ avec le `jobId` déterministe. BullMQ déduplique :
   *     si un job avec le même `jobId` existe encore en Redis (cas rare), le
   *     second `add()` est un no-op silencieux.
   *
   * Retourne un récap pour observabilité.
   *
   * Idempotence forte :
   *  - L'`AutoReleaseExecutor` revalide les invariants
   *    (`canReleaseEscrow` + `tryAcquireLockTx`) avant tout side-effect.
   *  - Si une mission est passée `COMPLETED` ou `DISPUTE_OPEN` entre-temps,
   *    l'executor short-circuite et marque le job COMPLETED/CANCELLED.
   */
  async reenqueueStuck(opts: { now: Date }): Promise<{
    scanned: number
    relockReleased: number
    reenqueued: number
  }> {
    const candidates = await this.jobs.findStuckJobs({
      now: opts.now,
      graceMs: AUTO_RELEASE_SAFETY_GRACE_MS,
      stuckLockMs: AUTO_RELEASE_STUCK_LOCK_MS,
      limit: AUTO_RELEASE_SAFETY_LIMIT,
    })
    let relockReleased = 0
    let reenqueued = 0
    const stuckLockCutoff = new Date(opts.now.getTime() - AUTO_RELEASE_STUCK_LOCK_MS)
    for (const job of candidates) {
      if (job.status === 'RUNNING') {
        const r = await this.prisma.$transaction((tx) =>
          this.jobs.releaseStuckLockTx(tx, { jobId: job.id, stuckLockCutoff }),
        )
        if (r === 0) {
          // Le worker a relâché le lock entre `findStuckJobs` et la
          // transaction → on saute, le job vit sa vie normale.
          this.logger.log(
            { autoReleaseJobId: job.id, missionId: job.missionId },
            'auto-release.safety.skip_lock_race',
          )
          continue
        }
        relockReleased += 1
      }
      // Replanifie rapidement : on rebascule à ~10s après `now`. Le worker
      // BullMQ ne traitera que si Redis prend bien le job — sinon le cron
      // suivant rejouera. `jobId` déterministe = pas de doublon.
      const delayedAt = new Date(opts.now.getTime() + 10_000)
      try {
        await this.enqueueDelayedJob({
          autoReleaseJobId: job.id,
          missionId: job.missionId,
          scheduledFor: delayedAt,
          bullJobId: buildAutoReleaseBullJobId(job.missionId),
          now: opts.now,
        })
        reenqueued += 1
      } catch (err) {
        // Ne casse pas la boucle : on log et on continue, le cron rejouera.
        this.logger.warn(
          {
            autoReleaseJobId: job.id,
            missionId: job.missionId,
            err: err instanceof Error ? err.message : 'unknown',
          },
          'auto-release.safety.reenqueue_failed',
        )
      }
    }
    this.logger.log(
      { scanned: candidates.length, relockReleased, reenqueued },
      'auto-release.safety.tick_done',
    )
    return { scanned: candidates.length, relockReleased, reenqueued }
  }
}
