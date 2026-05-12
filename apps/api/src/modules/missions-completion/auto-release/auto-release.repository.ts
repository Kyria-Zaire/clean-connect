/**
 * PRD-003 Ticket 3.4 — Repository Prisma pour `AutoReleaseJob`.
 *
 * Aucune logique métier ici. Toutes les méthodes mutantes acceptent un
 * `Prisma.TransactionClient` pour orchestration atomique côté service
 * (rule architecte-api).
 *
 * Invariants :
 *  - `(mission_id, status='SCHEDULED')` : 0 ou 1 ligne active à la fois
 *    (la création utilise `INSERT … ON CONFLICT DO UPDATE` pour replay safe).
 *  - `bullJobId` unique global — déterministe via
 *    `buildAutoReleaseBullJobId(missionId)`.
 *  - `lockedAt` + `lockedBy` posés atomiquement par le processor avant
 *    le traitement (verrou applicatif anti double-exécution V10).
 */

import { Injectable } from '@nestjs/common'
import type { AutoReleaseJob, Prisma } from '@prisma/client'

import { PrismaService } from '../../../common/prisma/prisma.service'

@Injectable()
export class AutoReleaseJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  findActiveByMissionId(missionId: string): Promise<AutoReleaseJob | null> {
    return this.prisma.autoReleaseJob.findFirst({
      where: { missionId, status: 'SCHEDULED' },
      orderBy: { createdAt: 'desc' },
    })
  }

  findById(id: string): Promise<AutoReleaseJob | null> {
    return this.prisma.autoReleaseJob.findUnique({ where: { id } })
  }

  findByBullJobId(bullJobId: string): Promise<AutoReleaseJob | null> {
    return this.prisma.autoReleaseJob.findUnique({ where: { bullJobId } })
  }

  /**
   * PRD-004 Ticket 4.2 — Safety-net cron horaire (AC-4.2.4.1 + AC-4.2.2.1).
   *
   * Retourne les jobs candidats à un re-enqueue :
   *  - `SCHEDULED` + `scheduledFor < now - graceMs` : delayed BullMQ perdu
   *    (Redis purge, restart sans persistance, etc.). Le job DB existe mais
   *    Bull a perdu la trace → on rejoue.
   *  - `RUNNING` + `lockedAt < now - stuckLockMs` : worker crashé entre le
   *    `tryAcquireLockTx` et le `markCompletedTx`/`markFailedTx`. Le lock
   *    applicatif n'a jamais été relâché → on relâche puis on rejoue.
   *
   * Limite stricte (`take`) pour borner la charge d'un tick cron.
   * `orderBy scheduledFor asc` : les plus vieux d'abord (priorité au cas
   * où la file s'accumule).
   *
   * IMPORTANT : aucune mutation ici. Le caller (`AutoReleaseService.
   * reenqueueStuck`) lit, vérifie les invariants métier dans une
   * transaction dédiée, puis poste le job BullMQ.
   */
  async findStuckJobs(opts: {
    now: Date
    graceMs: number
    stuckLockMs: number
    limit: number
  }): Promise<AutoReleaseJob[]> {
    const overdueCutoff = new Date(opts.now.getTime() - opts.graceMs)
    const stuckLockCutoff = new Date(opts.now.getTime() - opts.stuckLockMs)
    return this.prisma.autoReleaseJob.findMany({
      where: {
        OR: [
          { status: 'SCHEDULED', scheduledFor: { lte: overdueCutoff } },
          { status: 'RUNNING', lockedAt: { lte: stuckLockCutoff } },
        ],
      },
      orderBy: { scheduledFor: 'asc' },
      take: opts.limit,
    })
  }

  /**
   * Relâche un lock applicatif orphelin (status `RUNNING` mais worker crashé).
   * Idempotent : seuls les jobs `RUNNING` avec `lockedAt` strictement antérieur
   * au cutoff sont impactés. Repose le job à `SCHEDULED` pour permettre une
   * nouvelle exécution.
   */
  async releaseStuckLockTx(
    tx: Prisma.TransactionClient,
    opts: { jobId: string; stuckLockCutoff: Date },
  ): Promise<number> {
    const r = await tx.autoReleaseJob.updateMany({
      where: {
        id: opts.jobId,
        status: 'RUNNING',
        lockedAt: { lte: opts.stuckLockCutoff },
      },
      data: {
        status: 'SCHEDULED',
        lockedAt: null,
        lockedBy: null,
        startedAt: null,
      },
    })
    return r.count
  }

  // ---------------------------------------------------------------------------
  // Mutations transactionnelles
  // ---------------------------------------------------------------------------

  /**
   * Insère (ou retourne) un job SCHEDULED pour la mission donnée.
   *
   * Idempotence forte : le `bullJobId` est unique global ; si une ligne
   * existe déjà pour cette mission, on retourne l'existante sans erreur
   * (cas attendu : `POST /complete` rejoué côté mobile).
   */
  async upsertScheduledTx(
    tx: Prisma.TransactionClient,
    input: {
      missionId: string
      bullJobId: string
      idempotencyKey: string
      scheduledFor: Date
    },
  ): Promise<{ job: AutoReleaseJob; created: boolean }> {
    const existing = await tx.autoReleaseJob.findUnique({
      where: { bullJobId: input.bullJobId },
    })
    if (existing) {
      return { job: existing, created: false }
    }
    const created = await tx.autoReleaseJob.create({
      data: {
        missionId: input.missionId,
        bullJobId: input.bullJobId,
        idempotencyKey: input.idempotencyKey,
        scheduledFor: input.scheduledFor,
        status: 'SCHEDULED',
      },
    })
    return { job: created, created: true }
  }

  /**
   * Verrou applicatif (audit V10) — atomique : pose `lockedAt` + `lockedBy`
   * uniquement si la ligne est encore `SCHEDULED` et `lockedAt IS NULL`.
   * Renvoie 1 si le verrou est pris à l'instant, 0 sinon.
   */
  async tryAcquireLockTx(
    tx: Prisma.TransactionClient,
    opts: { jobId: string; lockedBy: string; now: Date },
  ): Promise<number> {
    const r = await tx.autoReleaseJob.updateMany({
      where: { id: opts.jobId, status: 'SCHEDULED', lockedAt: null },
      data: {
        lockedAt: opts.now,
        lockedBy: opts.lockedBy,
        status: 'RUNNING',
        startedAt: opts.now,
      },
    })
    return r.count
  }

  /** Marque le job COMPLETED (capture déclenchée avec succès) — idempotent. */
  async markCompletedTx(
    tx: Prisma.TransactionClient,
    opts: { jobId: string; now: Date },
  ): Promise<number> {
    const r = await tx.autoReleaseJob.updateMany({
      where: { id: opts.jobId, status: { in: ['SCHEDULED', 'RUNNING'] } },
      data: {
        status: 'COMPLETED',
        finishedAt: opts.now,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    })
    return r.count
  }

  /**
   * Marque le job CANCELLED (client a validé ou ouvert un litige avant
   * T+48h ouvrées). Idempotent : aucune mutation si déjà terminal.
   */
  async cancelTx(
    tx: Prisma.TransactionClient,
    opts: { missionId: string; reason: string; now: Date },
  ): Promise<number> {
    const r = await tx.autoReleaseJob.updateMany({
      where: { missionId: opts.missionId, status: 'SCHEDULED' },
      data: {
        status: 'CANCELLED',
        cancelReason: opts.reason,
        finishedAt: opts.now,
        lockedAt: null,
        lockedBy: null,
      },
    })
    return r.count
  }

  /**
   * Marque le job FAILED (capture Stripe en erreur — `authorization_expired`,
   * `card_declined`, etc.). Relâche le verrou pour permettre un retry par un
   * autre worker ou un cron safety-net horaire (Ticket 3.5).
   */
  async markFailedTx(
    tx: Prisma.TransactionClient,
    opts: { jobId: string; lastError: string; now: Date },
  ): Promise<number> {
    const r = await tx.autoReleaseJob.updateMany({
      where: { id: opts.jobId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        lastError: opts.lastError.slice(0, 4_000),
        lockedAt: null,
        lockedBy: null,
        finishedAt: opts.now,
      },
    })
    return r.count
  }
}
