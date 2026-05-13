import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import type Stripe from 'stripe'

import { loadEnv } from '../../../common/config/env'
import { FINANCE_LOCK_KEYS, FINANCE_LOCK_TTL_MS, FINANCE_RECONCILE_WINDOW_DAYS } from '../finance.constants'
import type { PaymentBundle } from '../finance.repository'
import { FinanceRepository } from '../finance.repository'
import type { InvariantClock, PaymentInvariantInput } from '../invariants/invariant.contract'
import { RECONCILE_INVARIANTS } from '../invariants/registry'
import { FinanceSchedulerLockService } from '../locking/finance-scheduler-lock.service'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'
import { StripeFinanceRetrieveService } from '../stripe/stripe-finance-retrieve.service'

import { FinanceMismatchService } from './finance-mismatch.service'

/**
 * PRD-004 Ticket 4.5 Build itération 2 — Reconcile orchestrator.
 *
 * Règle CTO : "le scheduler doit seulement déclencher / verrouiller / timeout
 * / observer / appeler un service métier déterministe". Ce service EST le
 * service métier déterministe : il itère sur les Payments DB modifiés sur les
 * 7 derniers jours, retrieve leurs pendants Stripe (read-only), applique les
 * 8 invariants `reconcile` du registry, et persiste les `InvariantBreak` détectés
 * via `FinanceMismatchService.persist`.
 *
 * Garanties :
 *  - **Aucune mutation Stripe**.
 *  - **Aucune correction destructive DB** — uniquement des inserts dans
 *    `finance_mismatches` et `finance_alerts`.
 *  - **Idempotent** — la dedup naturelle `(runId, mismatchCode, resourceKind, resourceId)`
 *    garantit qu'un re-run sur le même runId est sans effet.
 *  - **Anti-overlap (Verify F1)** — le manual run et le cron passent par le même
 *    `FINANCE_LOCK_KEYS.reconcile`.
 *  - **Pagination bornée (`FIN-RECONCILE-PAGING` PRD §4.15.17)** — fenêtre 7j +
 *    boucle cursor `updatedAt,id` avec `FINANCE_RECONCILE_BATCH_SIZE` ×
 *    `FINANCE_RECONCILE_MAX_PAGES` plafond absolu. Log `window_truncated` si la
 *    fenêtre dépasse le budget (aucune correction automatique).
 */
@Injectable()
export class FinanceReconcileService {
  private readonly logger = new Logger(FinanceReconcileService.name)
  private readonly clock: InvariantClock = { now: () => new Date() }

  constructor(
    private readonly repo: FinanceRepository,
    private readonly locks: FinanceSchedulerLockService,
    private readonly stripe: StripeFinanceRetrieveService,
    private readonly mismatches: FinanceMismatchService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  /** Cron entrypoint. Lock déjà tenu par le scheduler. Crée son propre run. */
  async runScheduledReconcile(): Promise<void> {
    const windowTo = this.clock.now()
    const windowFrom = new Date(
      windowTo.getTime() - FINANCE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60_000,
    )
    const run = await this.repo.createRun({
      type: 'RECONCILE',
      windowFrom,
      windowTo,
      triggeredByUserId: null,
    })
    await this.executeReconcile({ runId: run.id, windowFrom, windowTo, triggeredByUserId: null })
  }

  /**
   * `FIN-MANUAL-RATELIMIT` (PRD-004 §4.15.17) — Endpoint admin entrypoint.
   *
   * Pipeline atomique :
   *  1. `tryReserveManualRun` (advisory lock user-scoped) — `count + INSERT`
   *     en une seule transaction Postgres ⇒ pas de race possible 2×/heure.
   *     Si quota dépassé → `429 FINANCE_MANUAL_RUN_RATE_LIMIT` (aucun row créé).
   *  2. `withLock(reconcile)` global (anti-overlap CTO) → exécute le run.
   *     Si busy → run réservé immédiatement marqué `FAILED('lock_busy')`,
   *     `409 FINANCE_RECONCILE_BUSY`.
   *
   * Sémantique stable et testée :
   *  - `429` = rate-limit OQ-13 dépassé pour cet admin sur 1h glissante.
   *  - `409` = un autre run reconcile (cron ou manuel) est déjà en cours.
   */
  async runManual(userId: string): Promise<{ runId: string }> {
    const env = loadEnv()
    const windowTo = this.clock.now()
    const windowFrom = new Date(
      windowTo.getTime() - FINANCE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60_000,
    )
    const since = new Date(windowTo.getTime() - 60 * 60_000)

    const reservation = await this.repo.tryReserveManualRun({
      userId,
      limit: env.FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR,
      since,
      windowFrom,
      windowTo,
    })
    if (!reservation.ok) {
      this.logger.warn(`finance.reconcile.manual.rate_limited userId=${userId}`)
      throw new HttpException(
        { error: 'FINANCE_MANUAL_RUN_RATE_LIMIT' },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    return this.runManualOnReservedRun({
      runId: reservation.runId,
      userId,
      windowFrom,
      windowTo,
    })
  }

  private async runManualOnReservedRun(args: {
    runId: string
    userId: string
    windowFrom: Date
    windowTo: Date
  }): Promise<{ runId: string }> {
    const outcome = await this.locks.withLock(
      FINANCE_LOCK_KEYS.reconcile,
      FINANCE_LOCK_TTL_MS.reconcile,
      async () =>
        this.executeReconcile({
          runId: args.runId,
          windowFrom: args.windowFrom,
          windowTo: args.windowTo,
          triggeredByUserId: args.userId,
        }),
    )

    if (!outcome.acquired) {
      this.logger.warn(`finance.reconcile.manual.busy userId=${args.userId} runId=${args.runId}`)
      // Le run réservé doit être marqué FAILED — il ne sera jamais exécuté.
      // Sans cela il resterait `RUNNING` jusqu'au cleanup `FIN-STALE-RUNS`.
      await this.repo.failRun(args.runId, 'lock_busy').catch((e) => {
        this.logger.error(
          `finance.reconcile.manual.fail_run_failed runId=${args.runId} err=${stringErr(e)}`,
        )
      })
      throw new HttpException({ error: 'FINANCE_RECONCILE_BUSY' }, HttpStatus.CONFLICT)
    }
    return { runId: outcome.result.runId }
  }

  private async executeReconcile(args: {
    runId: string
    windowFrom: Date
    windowTo: Date
    triggeredByUserId: string | null
  }): Promise<{ runId: string; mismatchesFound: number; alertsEmitted: number }> {
    const { runId, windowFrom, windowTo, triggeredByUserId } = args
    this.logger.log(
      `finance.reconcile.run.start runId=${runId} from=${windowFrom.toISOString()} to=${windowTo.toISOString()} triggeredBy=${triggeredByUserId ?? 'cron'}`,
    )

    const startMs = Date.now()
    let mismatchesFound = 0
    let alertsEmitted = 0
    let resourcesScanned = 0

    try {
      const env = loadEnv()
      const batchSize = env.FINANCE_RECONCILE_BATCH_SIZE
      const maxPages = env.FINANCE_RECONCILE_MAX_PAGES

      let cursor: { updatedAt: Date; id: string } | undefined
      let pagesProcessed = 0
      let lastBatchLen = 0

      while (pagesProcessed < maxPages) {
        const bundles = await this.repo.listRecentPaymentsForReconcile({
          from: windowFrom,
          to: windowTo,
          limit: batchSize,
          cursor: cursor ?? null,
        })
        lastBatchLen = bundles.length
        if (bundles.length === 0) break

        resourcesScanned += bundles.length

        for (const bundle of bundles) {
          const stripeBundle = await this.fetchStripeBundle(bundle)
          const input: PaymentInvariantInput = {
            payment: bundle.payment,
            transfer: bundle.transfer,
            refunds: bundle.refunds,
            stripe: stripeBundle,
          }

          for (const inv of RECONCILE_INVARIANTS) {
            const result = inv.apply(input, this.clock)
            if (!result) continue
            const persisted = await this.mismatches.persist({
              runId,
              invariantBreak: result,
            })
            if (persisted.persisted === 'created') mismatchesFound += 1
            if (persisted.alerted) alertsEmitted += 1
          }
        }

        pagesProcessed += 1
        if (bundles.length < batchSize) break

        const last = bundles[bundles.length - 1]
        if (!last) break
        cursor = { updatedAt: last.payment.updatedAt, id: last.payment.id }
      }

      if (pagesProcessed === maxPages && lastBatchLen === batchSize) {
        const peek = await this.repo.listRecentPaymentsForReconcile({
          from: windowFrom,
          to: windowTo,
          limit: 1,
          cursor: cursor ?? null,
        })
        if (peek.length > 0) {
          this.logger.warn(
            `finance.reconcile.run.window_truncated runId=${runId} maxPages=${maxPages} batchSize=${batchSize} scanned=${resourcesScanned}`,
          )
        }
      }

      await this.repo.completeRun(runId, {
        resourcesScanned,
        mismatchesFound,
        alertsEmitted,
      })
      this.metrics.recordRun({
        type: 'RECONCILE',
        status: 'COMPLETED',
        durationMs: Date.now() - startMs,
      })
      this.logger.log(
        `finance.reconcile.run.done runId=${runId} scanned=${resourcesScanned} mismatches=${mismatchesFound} alerts=${alertsEmitted}`,
      )
      return { runId, mismatchesFound, alertsEmitted }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      await this.repo.failRun(runId, msg)
      this.metrics.recordRun({
        type: 'RECONCILE',
        status: 'FAILED',
        durationMs: Date.now() - startMs,
      })
      this.logger.error(`finance.reconcile.run.failed runId=${runId} reason=${msg}`)
      throw e
    }
  }

  /**
   * Retrieve les pendants Stripe d'un Payment (PI + Transfer + Refunds avec
   * stripeRefundId). Tolère les 404 (=> null) pour permettre la détection
   * `MISSING_STRIPE` future. Aucun throw bloquant : si Stripe est partiellement
   * indisponible, on renvoie null et l'invariant correspondant ne se déclenche
   * pas (les invariants DB-only restent appliqués).
   */
  private async fetchStripeBundle(bundle: PaymentBundle): Promise<{
    paymentIntent: Stripe.PaymentIntent | null
    transfer: Stripe.Transfer | null
    refunds: readonly Stripe.Refund[]
  }> {
    const piId = bundle.payment.stripePaymentIntentId
    const trId = bundle.transfer?.stripeTransferId ?? null
    const refundIds = bundle.refunds
      .map((r) => r.stripeRefundId)
      .filter((id): id is string => Boolean(id))

    const [pi, tr, ...refunds] = await Promise.all([
      this.stripe.retrievePaymentIntent(piId).catch((err) => {
        this.logger.warn(
          `finance.reconcile.stripe.pi_retrieve_failed paymentId=${bundle.payment.id} err=${stringErr(err)}`,
        )
        return null
      }),
      trId
        ? this.stripe.retrieveTransfer(trId).catch((err) => {
            this.logger.warn(
              `finance.reconcile.stripe.transfer_retrieve_failed transferId=${bundle.transfer?.id} err=${stringErr(err)}`,
            )
            return null
          })
        : Promise.resolve(null),
      ...refundIds.map((id) =>
        this.stripe.retrieveRefund(id).catch((err) => {
          this.logger.warn(
            `finance.reconcile.stripe.refund_retrieve_failed refundIdShort=${id.slice(0, 12)} err=${stringErr(err)}`,
          )
          return null
        }),
      ),
    ])

    return {
      paymentIntent: pi,
      transfer: tr,
      refunds: refunds.filter((r): r is Stripe.Refund => r !== null),
    }
  }
}

function stringErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
