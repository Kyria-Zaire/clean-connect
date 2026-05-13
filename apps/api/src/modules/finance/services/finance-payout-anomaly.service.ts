import { Injectable, Logger } from '@nestjs/common'

import { loadEnv } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { deepSanitize } from '../../../common/security/sanitize'
import {
  FinanceAlertingService,
  type FinanceAlertKind,
} from '../alerting/finance-alerting.service'
import { FINANCE_THRESHOLDS } from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'

/**
 * PRD-004 Ticket 4.5 Build itération 2 — Détecteur d'anomalies de payout.
 *
 * Pour chaque prestataire ayant un Transfer SENT en J-1 :
 *  - Calcule la moyenne `amountCents` sur la fenêtre 30 j (hors J-1).
 *  - Si `J-1 > FACTOR × moyenne 30 j` ⇒ alerte `finance_payout_anomaly` (P2).
 *
 * Cooldown 24 h par prestataire (truncated id, jamais de userId complet).
 *
 * Aucune mutation Stripe. Aucun fix automatique.
 *
 * NOTE : pas d'invariant atomique pour ce détecteur car la logique nécessite
 * une agrégation multi-prestataires (les invariants atomiques opèrent sur 1 row).
 * On reste conforme au pattern : service métier déterministe + alert + audit.
 */
@Injectable()
export class FinancePayoutAnomalyService {
  private readonly logger = new Logger(FinancePayoutAnomalyService.name)
  private static readonly KIND: FinanceAlertKind = 'finance_payout_anomaly'

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FinanceRepository,
    private readonly metrics: FinanceMetricsTracker,
    private readonly alerting: FinanceAlertingService,
  ) {}

  async run(): Promise<void> {
    const env = loadEnv()
    const factor = env.FINANCE_PAYOUT_ANOMALY_FACTOR
    const now = new Date()
    const j1Start = new Date(now.getTime() - 24 * 60 * 60_000)
    const windowFrom = new Date(now.getTime() - FINANCE_THRESHOLDS.payoutAvgWindowDays * 24 * 60 * 60_000)

    const run = await this.repo.createRun({
      type: 'PAYOUT_ANOMALY',
      windowFrom,
      windowTo: now,
      triggeredByUserId: null,
    })
    this.logger.log({
      msg: 'finance.payout_anomaly.run.start',
      runId: run.id,
      factor,
      windowFrom: windowFrom.toISOString(),
    })
    const startMs = Date.now()
    let alertsEmitted = 0
    let anomalies = 0

    try {
      // Note : Prisma n'expose pas Mission.providerId pour join direct ici sans
      // requête raw. On préfère 2 queries simples pour rester typés et lisibles.
      const j1Transfers = await this.prisma.transfer.findMany({
        where: { status: 'SENT', updatedAt: { gte: j1Start, lt: now } },
        select: {
          id: true,
          amountCents: true,
          payment: { select: { mission: { select: { prestataireId: true } } } },
        },
      })

      const byPrestataire = new Map<
        string,
        { sumCents: number; count: number; transferIds: string[] }
      >()
      for (const t of j1Transfers) {
        const pid = t.payment?.mission?.prestataireId
        if (!pid) continue
        const cur = byPrestataire.get(pid) ?? { sumCents: 0, count: 0, transferIds: [] }
        cur.sumCents += t.amountCents
        cur.count += 1
        cur.transferIds.push(t.id)
        byPrestataire.set(pid, cur)
      }

      for (const [prestataireId, j1] of byPrestataire) {
        const previous = await this.prisma.transfer.aggregate({
          where: {
            status: 'SENT',
            updatedAt: { gte: windowFrom, lt: j1Start },
            payment: { mission: { prestataireId } },
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        })
        const prevCount = previous._count._all
        if (prevCount === 0) continue
        const avgPrev = (previous._sum.amountCents ?? 0) / prevCount
        if (avgPrev <= 0) continue
        const j1Avg = j1.sumCents / j1.count
        const ratio = j1Avg / avgPrev
        this.metrics.observePayoutAnomalyFactor(ratio)

        if (ratio < factor) continue

        anomalies += 1
        const outcome = await this.alerting.emit({
          kind: FinancePayoutAnomalyService.KIND,
          severity: 'P2',
          cooldownScope: prestataireId.slice(0, 8),
          runId: run.id,
          context: deepSanitize({
            prestataireIdShort: prestataireId.slice(0, 8),
            factor,
            ratio,
            j1AvgCents: Math.trunc(j1Avg),
            avg30dCents: Math.trunc(avgPrev),
            j1Count: j1.count,
            prevCount,
          }),
        })
        if (outcome.emitted) alertsEmitted += 1
      }

      await this.repo.completeRun(run.id, {
        resourcesScanned: byPrestataire.size,
        mismatchesFound: 0,
        alertsEmitted,
      })
      this.metrics.recordRun({
        type: 'PAYOUT_ANOMALY',
        status: 'COMPLETED',
        durationMs: Date.now() - startMs,
      })
      this.logger.log(
        `finance.payout_anomaly.run.done runId=${run.id} prestataires=${byPrestataire.size} anomalies=${anomalies} alerts=${alertsEmitted}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      await this.repo.failRun(run.id, msg)
      this.metrics.recordRun({
        type: 'PAYOUT_ANOMALY',
        status: 'FAILED',
        durationMs: Date.now() - startMs,
      })
      this.logger.error(`finance.payout_anomaly.run.failed runId=${run.id} reason=${msg}`)
      throw e
    }
  }
}
