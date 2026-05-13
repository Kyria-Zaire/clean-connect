import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import type Stripe from 'stripe'

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
 *  - **Resource cap** — fenêtre 7j + `RECONCILE_BATCH_SIZE` plafonné pour éviter
 *    une charge incontrôlée. Les itérations suivantes traitent le reste.
 *
 * TODO(debt) iteration-3 :
 *  - Si > batch size, planifier un sous-run pour la suite (curseur `updatedAt`)
 *  - Mode "missing-only" pour redémarrer sans tout retrebrasser
 *  - Détection MISSING_DB côté Stripe (Transfers/Refunds créés directement
 *    depuis le dashboard) — nécessite un `stripe.events.list` ⇒ ADR future.
 */
@Injectable()
export class FinanceReconcileService {
  private readonly logger = new Logger(FinanceReconcileService.name)
  /**
   * Plafond de Payments scannés par run reconcile. Borne dure pour éviter une
   * dégradation Stripe (max 25 req/s × 3 retrieve par Payment = ~8 Payments/s).
   * 600 Payments = ~5 min worst-case en respectant le rate-limit.
   */
  private static readonly RECONCILE_BATCH_SIZE = 600
  private readonly clock: InvariantClock = { now: () => new Date() }

  constructor(
    private readonly repo: FinanceRepository,
    private readonly locks: FinanceSchedulerLockService,
    private readonly stripe: StripeFinanceRetrieveService,
    private readonly mismatches: FinanceMismatchService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  /** Cron entrypoint. Lock déjà tenu par le scheduler. */
  async runScheduledReconcile(): Promise<void> {
    await this.executeReconcile({ triggeredByUserId: null })
  }

  /**
   * Endpoint admin entrypoint. Acquiert le lock `reconcile` (anti-overlap CTO).
   * Renvoie 409 sans créer de run si un autre run est en cours.
   */
  async runManual(userId: string): Promise<{ runId: string }> {
    const outcome = await this.locks.withLock(
      FINANCE_LOCK_KEYS.reconcile,
      FINANCE_LOCK_TTL_MS.reconcile,
      async () => this.executeReconcile({ triggeredByUserId: userId }),
    )

    if (!outcome.acquired) {
      this.logger.warn(`finance.reconcile.manual.busy userId=${userId}`)
      throw new HttpException({ error: 'FINANCE_RECONCILE_BUSY' }, HttpStatus.CONFLICT)
    }
    return { runId: outcome.result.runId }
  }

  private async executeReconcile(args: {
    triggeredByUserId: string | null
  }): Promise<{ runId: string; mismatchesFound: number; alertsEmitted: number }> {
    const windowTo = this.clock.now()
    const windowFrom = new Date(
      windowTo.getTime() - FINANCE_RECONCILE_WINDOW_DAYS * 24 * 60 * 60_000,
    )

    const run = await this.repo.createRun({
      type: 'RECONCILE',
      windowFrom,
      windowTo,
      triggeredByUserId: args.triggeredByUserId,
    })
    this.logger.log(
      `finance.reconcile.run.start runId=${run.id} from=${windowFrom.toISOString()} to=${windowTo.toISOString()} triggeredBy=${args.triggeredByUserId ?? 'cron'}`,
    )

    const startMs = Date.now()
    let mismatchesFound = 0
    let alertsEmitted = 0
    let resourcesScanned = 0

    try {
      const bundles = await this.repo.listRecentPaymentsForReconcile({
        from: windowFrom,
        to: windowTo,
        limit: FinanceReconcileService.RECONCILE_BATCH_SIZE,
      })
      resourcesScanned = bundles.length

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
            runId: run.id,
            invariantBreak: result,
          })
          if (persisted.persisted === 'created') mismatchesFound += 1
          if (persisted.alerted) alertsEmitted += 1
        }
      }

      await this.repo.completeRun(run.id, {
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
        `finance.reconcile.run.done runId=${run.id} scanned=${resourcesScanned} mismatches=${mismatchesFound} alerts=${alertsEmitted}`,
      )
      return { runId: run.id, mismatchesFound, alertsEmitted }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      await this.repo.failRun(run.id, msg)
      this.metrics.recordRun({
        type: 'RECONCILE',
        status: 'FAILED',
        durationMs: Date.now() - startMs,
      })
      this.logger.error(`finance.reconcile.run.failed runId=${run.id} reason=${msg}`)
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
