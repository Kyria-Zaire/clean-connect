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

import {
  AUTO_RELEASE_BACKOFF_BASE_MS,
  AUTO_RELEASE_BUSINESS_HOURS,
  AUTO_RELEASE_MAX_ATTEMPTS,
  AUTO_RELEASE_PROCESS_JOB,
  AUTO_RELEASE_QUEUE,
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
      { autoReleaseJobId: opts.autoReleaseJobId, missionId: opts.missionId },
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
}
