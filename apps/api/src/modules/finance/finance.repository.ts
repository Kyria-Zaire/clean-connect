import { Injectable } from '@nestjs/common'
import {
  type FinanceMismatchStatus,
  type FinanceMismatchType,
  type FinanceResourceKind,
  type FinanceRunType,
  type Payment,
  type Prisma,
  type Refund,
  type Transfer,
} from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'

import type { FinanceInvariantCode } from './finance.constants'

/** Bundle Payment + relations utilisées par le reconcile orchestrator. */
export interface PaymentBundle {
  payment: Payment
  transfer: Transfer | null
  refunds: readonly Refund[]
  missionStatus: string | null
}

@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(args: {
    type: FinanceRunType
    windowFrom: Date
    windowTo: Date
    triggeredByUserId?: string | null
  }): Promise<{ id: string }> {
    return this.prisma.financeReconciliationRun.create({
      data: {
        type: args.type,
        status: 'RUNNING',
        windowFrom: args.windowFrom,
        windowTo: args.windowTo,
        triggeredByUserId: args.triggeredByUserId ?? null,
      },
      select: { id: true },
    })
  }

  async completeRun(
    id: string,
    patch: Pick<Prisma.FinanceReconciliationRunUpdateInput, 'resourcesScanned' | 'mismatchesFound' | 'alertsEmitted'>,
  ): Promise<void> {
    const completedAt = new Date()
    const run = await this.prisma.financeReconciliationRun.findUniqueOrThrow({
      where: { id },
      select: { startedAt: true },
    })
    const durationMs = completedAt.getTime() - run.startedAt.getTime()
    await this.prisma.financeReconciliationRun.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt,
        durationMs,
        ...patch,
      },
    })
  }

  async failRun(id: string, failureMessage: string): Promise<void> {
    const completedAt = new Date()
    const run = await this.prisma.financeReconciliationRun.findUniqueOrThrow({
      where: { id },
      select: { startedAt: true },
    })
    const durationMs = completedAt.getTime() - run.startedAt.getTime()
    await this.prisma.financeReconciliationRun.update({
      where: { id },
      data: {
        status: 'FAILED',
        completedAt,
        durationMs,
        failureMessage,
      },
    })
  }

  async hasStaleRunningRun(type: FinanceRunType, maxAgeMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - maxAgeMs)
    const count = await this.prisma.financeReconciliationRun.count({
      where: { type, status: 'RUNNING', startedAt: { lt: cutoff } },
    })
    return count > 0
  }

  async markStaleRunningRunsFailed(type: FinanceRunType, maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs)
    const res = await this.prisma.financeReconciliationRun.updateMany({
      where: { type, status: 'RUNNING', startedAt: { lt: cutoff } },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        failureMessage: 'stale_run_detected',
      },
    })
    return res.count
  }

  /**
   * `FIN-STALE-RUNS` (PRD-004 §4.15.17) — Variante générique qui couvre tous
   * les `FinanceRunType`. Utile en début de tick `@Cron` pour nettoyer un run
   * orphelin laissé par un worker crashé avant le `release` du lock (le lock
   * lui-même expire seul via TTL, mais le row `FinanceReconciliationRun`
   * resterait `RUNNING` indéfiniment sans ce cleanup).
   *
   * Le `maxAgeMs` est par-type pour rester cohérent avec `FINANCE_LOCK_TTL_MS`
   * (ex. `report` = 10 min, `reconcile` = 15 min). On reprend le mapping
   * `FINANCE_RUN_TYPE_TO_LOCK_KEY` et `FINANCE_LOCK_TTL_MS` côté caller.
   *
   * Retourne le total de rows mis en `FAILED` (tous types confondus).
   */
  async markAllStaleRunningRunsFailed(
    maxAgeByType: Readonly<Record<FinanceRunType, number>>,
  ): Promise<number> {
    let total = 0
    const types = Object.keys(maxAgeByType) as FinanceRunType[]
    for (const t of types) {
      const maxAgeMs = maxAgeByType[t]
      if (typeof maxAgeMs !== 'number' || maxAgeMs <= 0) continue
      total += await this.markStaleRunningRunsFailed(t, maxAgeMs)
    }
    return total
  }

  async createMismatch(args: {
    runId: string
    mismatchCode: FinanceInvariantCode
    type: FinanceMismatchType
    resourceKind: FinanceResourceKind
    resourceId: string
    severity: string
    amountDeltaCents?: number | null
    dbSnapshot: Prisma.InputJsonValue
    stripeSnapshot?: Prisma.InputJsonValue | null
  }): Promise<{ id: string } | 'duplicate'> {
    try {
      const row = await this.prisma.financeMismatch.create({
        data: {
          runId: args.runId,
          mismatchCode: args.mismatchCode,
          type: args.type,
          resourceKind: args.resourceKind,
          resourceId: args.resourceId,
          severity: args.severity,
          amountDeltaCents: args.amountDeltaCents ?? null,
          dbSnapshot: args.dbSnapshot,
          stripeSnapshot: args.stripeSnapshot ?? undefined,
        },
        select: { id: true },
      })
      return row
    } catch (e) {
      if (isPrismaUniqueViolation(e)) return 'duplicate'
      throw e
    }
  }

  async listMismatches(args: {
    status?: FinanceMismatchStatus
    mismatchCode?: FinanceInvariantCode
    limit: number
    cursor?: string | null
  }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(args.limit, 1), 100)
    const where: Prisma.FinanceMismatchWhereInput = {}
    if (args.status) where.status = args.status
    if (args.mismatchCode) where.mismatchCode = args.mismatchCode
    const rows = await this.prisma.financeMismatch.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: take + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        runId: true,
        mismatchCode: true,
        type: true,
        resourceKind: true,
        resourceId: true,
        severity: true,
        amountDeltaCents: true,
        status: true,
        detectedAt: true,
        acknowledgedAt: true,
        acknowledgedByUserId: true,
        resolvedAt: true,
        resolvedByUserId: true,
        resolutionNotes: true,
      },
    })
    const hasMore = rows.length > take
    const items = hasMore ? rows.slice(0, take) : rows
    const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null
    return { items, nextCursor }
  }

  async getMismatch(id: string): Promise<unknown | null> {
    return this.prisma.financeMismatch.findUnique({ where: { id } })
  }

  async getMismatchStatus(
    id: string,
  ): Promise<{ status: FinanceMismatchStatus; mismatchCode: string; resourceKind: string; resourceId: string } | null> {
    return this.prisma.financeMismatch.findUnique({
      where: { id },
      select: { status: true, mismatchCode: true, resourceKind: true, resourceId: true },
    })
  }

  /**
   * Build itération 2 — Update lifecycle strict.
   * - `ACKNOWLEDGED` ⇒ pose `acknowledgedAt` + `acknowledgedByUserId`.
   * - `RESOLVED` / `IGNORED` ⇒ pose `resolvedAt` + `resolvedByUserId` (et préserve l'ACK si déjà posé).
   * - `INVESTIGATING` ⇒ aucune métadonnée temporelle posée (juste status).
   * Aucune transition implicite : la validation est faite en amont par
   * `FinanceMismatchService.transition` via `FINANCE_MISMATCH_TRANSITIONS`.
   */
  async updateMismatchStatus(args: {
    id: string
    status: FinanceMismatchStatus
    actorUserId: string
    notes?: string | null
  }): Promise<void> {
    const now = new Date()
    const data: Prisma.FinanceMismatchUpdateInput = { status: args.status }

    if (args.status === 'ACKNOWLEDGED') {
      data.acknowledgedAt = now
      data.acknowledgedByUserId = args.actorUserId
    }
    if (args.status === 'RESOLVED' || args.status === 'IGNORED') {
      data.resolvedAt = now
      data.resolvedByUserId = args.actorUserId
    }
    if (args.notes !== undefined) data.resolutionNotes = args.notes

    await this.prisma.financeMismatch.update({ where: { id: args.id }, data })
  }

  async countManualRunsSince(userId: string, since: Date): Promise<number> {
    return this.prisma.financeReconciliationRun.count({
      where: {
        type: 'RECONCILE',
        triggeredByUserId: userId,
        startedAt: { gte: since },
      },
    })
  }

  /**
   * `FIN-MANUAL-RATELIMIT` (PRD-004 §4.15.17) — Réservation atomique d'un
   * `FinanceReconciliationRun` manuel pour ADMIN, OQ-13 (1 run/heure/admin).
   *
   * Pattern : `pg_advisory_xact_lock(hashtext('finance.manual_rate:<userId>'))`
   *  → toute autre TX qui tente `tryReserveManualRun` pour le **même user**
   *  est sérialisée derrière la 1ère. Lock relâché à `COMMIT` / `ROLLBACK`.
   *
   * Pourquoi pas `SERIALIZABLE` global : on veut éviter la contention
   * inter-utilisateurs et les `SerializationError` aléatoires. L'advisory
   * lock scope `userId` est plus précis et compatible 1 instance / N admins.
   *
   * Retourne :
   *  - `{ ok: true, runId }` si quota disponible (row `RUNNING` créée).
   *  - `{ ok: false, reason: 'rate_limited' }` si `count >= limit`.
   *
   * Le runId créé reste `RUNNING` jusqu'à `completeRun` / `failRun` —
   * c'est `FIN-STALE-RUNS` qui couvre les crashs.
   */
  async tryReserveManualRun(args: {
    userId: string
    limit: number
    since: Date
    windowFrom: Date
    windowTo: Date
  }): Promise<{ ok: true; runId: string } | { ok: false; reason: 'rate_limited' }> {
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `finance.manual_rate:${args.userId}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`

      const count = await tx.financeReconciliationRun.count({
        where: {
          type: 'RECONCILE',
          triggeredByUserId: args.userId,
          startedAt: { gte: args.since },
        },
      })
      if (count >= args.limit) {
        return { ok: false as const, reason: 'rate_limited' as const }
      }

      const row = await tx.financeReconciliationRun.create({
        data: {
          type: 'RECONCILE',
          status: 'RUNNING',
          windowFrom: args.windowFrom,
          windowTo: args.windowTo,
          triggeredByUserId: args.userId,
        },
        select: { id: true },
      })
      return { ok: true as const, runId: row.id }
    })
  }

  async upsertDailyReport(args: {
    reportDate: Date
    windowFrom: Date
    windowTo: Date
    snapshot: Prisma.InputJsonValue
    capturedCents: number
    transferSentCents: number
    refundedCents: number
    commissionCents: number
    invariantBalanceCents: number
    capturedCount: number
    transferSentCount: number
    refundedCount: number
    openMismatchCount: number
  }): Promise<void> {
    await this.prisma.financeDailyReport.upsert({
      where: { reportDate: args.reportDate },
      create: {
        reportDate: args.reportDate,
        windowFrom: args.windowFrom,
        windowTo: args.windowTo,
        snapshot: args.snapshot,
        capturedCents: args.capturedCents,
        transferSentCents: args.transferSentCents,
        refundedCents: args.refundedCents,
        commissionCents: args.commissionCents,
        invariantBalanceCents: args.invariantBalanceCents,
        capturedCount: args.capturedCount,
        transferSentCount: args.transferSentCount,
        refundedCount: args.refundedCount,
        openMismatchCount: args.openMismatchCount,
      },
      update: {
        windowFrom: args.windowFrom,
        windowTo: args.windowTo,
        snapshot: args.snapshot,
        capturedCents: args.capturedCents,
        transferSentCents: args.transferSentCents,
        refundedCents: args.refundedCents,
        commissionCents: args.commissionCents,
        invariantBalanceCents: args.invariantBalanceCents,
        capturedCount: args.capturedCount,
        transferSentCount: args.transferSentCount,
        refundedCount: args.refundedCount,
        openMismatchCount: args.openMismatchCount,
        generatedAt: new Date(),
      },
    })
  }

  async getDailyReportByDate(reportDate: Date): Promise<unknown | null> {
    return this.prisma.financeDailyReport.findUnique({ where: { reportDate } })
  }

  /**
   * Build itération 2 — Liste les Payment modifiés/créés sur la fenêtre [from, to]
   * (modulo les missions DISPUTE_OPEN qui sont volontairement exclues — ADR-018 §2.8 cas A).
   * Ordonné par `updatedAt` desc, `id` desc pour une pagination cursor stable
   * (`FIN-RECONCILE-PAGING` PRD §4.15.17).
   *
   * Cursor (keyset) : première page `cursor=null` ; pages suivantes
   * `cursor = { updatedAt, id }` du **dernier** élément de la page précédente
   * (tuple strictement plus petit que le curseur dans l'ordre desc).
   */
  async listRecentPaymentsForReconcile(args: {
    from: Date
    to: Date
    limit: number
    cursor?: { updatedAt: Date; id: string } | null
  }): Promise<readonly PaymentBundle[]> {
    const take = Math.min(Math.max(args.limit, 1), 1000)
    const cursorWhere: Prisma.PaymentWhereInput | undefined = args.cursor
      ? {
            OR: [
              { updatedAt: { lt: args.cursor.updatedAt } },
              {
                AND: [{ updatedAt: args.cursor.updatedAt }, { id: { lt: args.cursor.id } }],
              },
            ],
          }
        : undefined

    const rows = await this.prisma.payment.findMany({
      where: {
        AND: [
          { updatedAt: { gte: args.from, lte: args.to } },
          { mission: { status: { not: 'DISPUTE_OPEN' } } },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      include: {
        transfer: true,
        refunds: true,
        mission: { select: { status: true } },
      },
    })
    return rows.map((r) => ({
      payment: stripRelations(r),
      transfer: r.transfer,
      refunds: r.refunds,
      missionStatus: r.mission?.status ?? null,
    }))
  }

  /**
   * Build itération 2 — Snapshot stuck-funds : ramène les Payment AUTHORIZED + CAPTURED
   * (susceptibles de stuck) et les Transfer PENDING. On limite la fenêtre à 30 j max
   * pour contenir la charge.
   */
  async listPaymentsForStuckScan(limit: number): Promise<readonly PaymentBundle[]> {
    const take = Math.min(Math.max(limit, 1), 1000)
    const rows = await this.prisma.payment.findMany({
      where: {
        status: { in: ['AUTHORIZED', 'CAPTURED'] },
        mission: { status: { not: 'DISPUTE_OPEN' } },
      },
      orderBy: { updatedAt: 'asc' },
      take,
      include: {
        transfer: true,
        refunds: true,
        mission: { select: { status: true } },
      },
    })
    return rows.map((r) => ({
      payment: stripRelations(r),
      transfer: r.transfer,
      refunds: r.refunds,
      missionStatus: r.mission?.status ?? null,
    }))
  }

  async listTransfersForStuckScan(limit: number): Promise<
    readonly { transfer: Transfer; payment: Payment | null; missionStatus: string | null }[]
  > {
    const take = Math.min(Math.max(limit, 1), 1000)
    const rows = await this.prisma.transfer.findMany({
      where: { status: 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      take,
      include: {
        payment: { include: { mission: { select: { status: true } } } },
      },
    })
    return rows.map((r) => ({
      transfer: { ...r, payment: undefined } as Transfer,
      payment: r.payment ?? null,
      missionStatus: r.payment?.mission?.status ?? null,
    }))
  }

  /**
   * Build itération 2 — Agrégats J-1 pour `FinanceDailyReport` + invariant FIN-J-001.
   * Fenêtre `[from, to]` exclusive sur to (UTC ; `from` à 00:00 Europe/Paris converti UTC).
   */
  async aggregateDailyReport(args: { from: Date; to: Date }): Promise<{
    capturedSumCents: number
    capturedCount: number
    transferSentSumCents: number
    transferSentCount: number
    refundedSumCents: number
    refundedCount: number
    applicationFeeSumCents: number
  }> {
    const [paymentsCaptured, transfersSent, refundsRefunded] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          status: { in: ['CAPTURED', 'REFUNDED', 'REFUND_PENDING'] },
          updatedAt: { gte: args.from, lt: args.to },
        },
        _sum: { amountCapturedCents: true, applicationFeeCents: true },
        _count: { _all: true },
      }),
      this.prisma.transfer.aggregate({
        where: { status: 'SENT', updatedAt: { gte: args.from, lt: args.to } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.refund.aggregate({
        where: { status: 'REFUNDED', updatedAt: { gte: args.from, lt: args.to } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
    ])

    return {
      capturedSumCents: paymentsCaptured._sum.amountCapturedCents ?? 0,
      capturedCount: paymentsCaptured._count._all,
      transferSentSumCents: transfersSent._sum.amountCents ?? 0,
      transferSentCount: transfersSent._count._all,
      refundedSumCents: refundsRefunded._sum.amountCents ?? 0,
      refundedCount: refundsRefunded._count._all,
      applicationFeeSumCents: paymentsCaptured._sum.applicationFeeCents ?? 0,
    }
  }

  async countOpenMismatchesBySeverity(): Promise<{ P1: number; P2: number }> {
    const rows = await this.prisma.financeMismatch.groupBy({
      by: ['severity'],
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
      _count: { _all: true },
    })
    let p1 = 0
    let p2 = 0
    for (const r of rows) {
      if (r.severity === 'P1') p1 = r._count._all
      if (r.severity === 'P2') p2 = r._count._all
    }
    return { P1: p1, P2: p2 }
  }

  async purgeMismatchesPastRetention(cutoff: Date): Promise<number> {
    const res = await this.prisma.financeMismatch.deleteMany({
      where: {
        OR: [
          { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] }, detectedAt: { lt: cutoff } },
          {
            status: { in: ['RESOLVED', 'IGNORED'] },
            resolvedAt: { not: null, lt: cutoff },
          },
        ],
      },
    })
    return res.count
  }

  async purgeDailyReportsOlderThan(cutoff: Date): Promise<number> {
    const res = await this.prisma.financeDailyReport.deleteMany({
      where: { reportDate: { lt: cutoff } },
    })
    return res.count
  }

  async purgeAlertsOlderThan(cutoff: Date): Promise<number> {
    const res = await this.prisma.financeAlert.deleteMany({
      where: { emittedAt: { lt: cutoff } },
    })
    return res.count
  }

  async purgeCompletedRunsOlderThan(cutoff: Date): Promise<number> {
    const res = await this.prisma.financeReconciliationRun.deleteMany({
      where: { status: 'COMPLETED', completedAt: { not: null, lt: cutoff } },
    })
    return res.count
  }
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}

/**
 * Build itération 2 — utilitaire interne. Le `payment` retourné par Prisma avec
 * `include: { transfer, refunds, mission }` contient ces relations dans l'objet
 * principal. On les retire explicitement avant de l'exposer comme `Payment` pur
 * (les invariants reçoivent les relations en arguments séparés).
 */
function stripRelations<T extends Payment & { transfer?: unknown; refunds?: unknown; mission?: unknown }>(
  row: T,
): Payment {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- relations retirées volontairement
  const { transfer, refunds, mission, ...rest } = row
  return rest as Payment
}
