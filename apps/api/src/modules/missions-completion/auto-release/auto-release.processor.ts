/**
 * PRD-003 Ticket 3.4 — `AutoReleaseProcessor` (consumer BullMQ).
 *
 * Wrapper *fin* autour de `AutoReleaseExecutor.run()`. Toute la logique
 * métier est dans l'executor — ce fichier ne fait que :
 *  - extraire le payload BullMQ,
 *  - propager les erreurs (pour déclencher le retry exponentiel + DLQ),
 *  - gérer le `@OnWorkerEvent('failed')` final pour journalisation
 *    (DLQ auto-release sera ajouté en Ticket 3.5).
 *
 * Garanties anti double-execution :
 *  - BullMQ déduplique sur `jobId` déterministe (`auto-release-mission-<id>`).
 *  - Verrou applicatif DB (audit V10) posé par `tryAcquireLockTx` côté
 *    executor — défense en profondeur si Redis perd le jobId (rare).
 */

import { hostname } from 'node:os'

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'

import {
  AUTO_RELEASE_MAX_ATTEMPTS,
  AUTO_RELEASE_PROCESS_JOB,
  AUTO_RELEASE_QUEUE,
} from './auto-release.constants'
import { AutoReleaseExecutor } from './auto-release.executor'
import type { AutoReleaseJobPayload } from './auto-release.service'

const WORKER_ID = `${hostname()}#${process.pid}`

@Processor(AUTO_RELEASE_QUEUE)
export class AutoReleaseProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoReleaseProcessor.name)

  constructor(private readonly executor: AutoReleaseExecutor) {
    super()
  }

  async process(job: Job<AutoReleaseJobPayload>): Promise<void> {
    if (job.name !== AUTO_RELEASE_PROCESS_JOB) {
      this.logger.warn(
        { jobName: job.name, bullJobId: job.id },
        'auto-release.processor.unknown_job_name',
      )
      return
    }

    const result = await this.executor.run({
      autoReleaseJobId: job.data.autoReleaseJobId,
      missionId: job.data.missionId,
      workerId: WORKER_ID,
    })

    this.logger.log(
      {
        autoReleaseJobId: job.data.autoReleaseJobId,
        missionId: job.data.missionId,
        bullJobId: job.id,
        attemptsMade: job.attemptsMade,
        outcome: result.outcome,
        reason: result.reason,
      },
      'auto-release.processor.processed',
    )
  }

  /**
   * Si BullMQ a épuisé tous les retries, on log un signal critique.
   * L'écriture en DLQ + replay UI admin = Ticket 3.5
   * (`TODO(debt): auto-release-dlq-ui`).
   */
  @OnWorkerEvent('failed')
  async onJobFailed(
    job: Job<AutoReleaseJobPayload> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) return
    if (job.attemptsMade < AUTO_RELEASE_MAX_ATTEMPTS) {
      this.logger.warn(
        {
          autoReleaseJobId: job.data.autoReleaseJobId,
          missionId: job.data.missionId,
          attempts: job.attemptsMade,
          err: err.message,
        },
        'auto-release.processor.retry_scheduled',
      )
      return
    }
    this.logger.error(
      {
        autoReleaseJobId: job.data.autoReleaseJobId,
        missionId: job.data.missionId,
        attempts: job.attemptsMade,
        // `lastError` est déjà persisté côté `auto_release_jobs` par l'executor.
      },
      'auto-release.processor.attempts_exhausted',
    )
  }
}
