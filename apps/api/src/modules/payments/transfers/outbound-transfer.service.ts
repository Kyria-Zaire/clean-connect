/**
 * PRD-003 Ticket 3.5 — Orchestration `stripe.transfers.create` après capture.
 *
 * Ordre CTO :
 *  1. `Payment.status === CAPTURED`
 *  2. `Mission.status === COMPLETED`
 *  3. Prestataire vérifié + capabilities (`providerPayoutStatus`, transfers/payouts/charges enabled)
 *  4. Aucun transfer `SENT` / `PENDING` actif concurrent (unique `paymentId`)
 *  5. Idempotency Stripe `transfer-mission-{missionId}`
 *
 * Metadata Stripe : **UUIDs uniquement** (`mission_id`, `payment_id`) — jamais d'email/adresse/téléphone.
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Mission, Payment, Transfer, User } from '@prisma/client'
import type Stripe from 'stripe'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { assertMissionTransition } from '../../missions/domain/mission-state.machine'
import { MissionsRepository } from '../../missions/missions.repository'
import { MissionEventService } from '../../missions/services/mission-event.service'
import { AlertingService } from '../../observability/alerting/alerting.service'
import { RetryMetricsTracker } from '../../observability/metrics/retry-metrics.tracker'
import { StripeMetricsTracker } from '../../observability/metrics/stripe-metrics.tracker'
import { STRIPE_CLIENT_TOKEN } from '../stripe/stripe.client'

import { classifyStripeTransferError } from './stripe-transfer-error'
import { TransferRetryQueueProducer } from './transfer-retry.queue'
import {
  buildTransferStripeIdempotencyKey,
  TRANSFER_MAX_API_ATTEMPTS,
  TRANSFER_RECONCILE_STALE_MS,
  TRANSFER_RETRY_QUEUE,
} from './transfer.constants'
import { TransfersRepository } from './transfers.repository'

export type OutboundTransferTrigger =
  | 'PAYMENT_CAPTURE_WEBHOOK'
  | 'RETRY_JOB'
  | 'ADMIN_RETRY'
  | 'RECONCILE_CRON'

@Injectable()
export class OutboundTransferService {
  private readonly logger = new Logger(OutboundTransferService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: TransfersRepository,
    private readonly missions: MissionsRepository,
    private readonly missionEvents: MissionEventService,
    private readonly stripeMetrics: StripeMetricsTracker,
    private readonly retryMetrics: RetryMetricsTracker,
    private readonly retryQueue: TransferRetryQueueProducer,
    private readonly alerting: AlertingService,
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe: Stripe,
  ) {}

  async ensureOutboundTransferAfterCapture(
    paymentId: string,
    trigger: Extract<OutboundTransferTrigger, 'PAYMENT_CAPTURE_WEBHOOK'>,
  ): Promise<void> {
    try {
      await this.executeOutboundTransfer(paymentId, trigger)
    } catch (err) {
      if (err instanceof TransferPayoutNotReadyError) {
        this.logger.warn({ paymentId, reason: err.reason }, 'transfer.outbound.payout_not_ready')
        return
      }
      throw err
    }
  }

  async retryFromJob(transferId: string): Promise<void> {
    const row = await this.transfers.findById(transferId)
    if (!row) {
      this.logger.warn({ transferId }, 'transfer.outbound.retry.transfer_not_found')
      return
    }
    if (row.status !== 'RETRY_SCHEDULED' && row.status !== 'PENDING') {
      this.logger.log({ transferId, status: row.status }, 'transfer.outbound.retry.skip_status')
      return
    }
    const payment = await this.prisma.payment.findUnique({
      where: { id: row.paymentId },
      include: { mission: { include: { prestataire: true } } },
    })
    if (!payment?.mission.prestataireId || !payment.mission.prestataire) {
      this.logger.warn({ transferId }, 'transfer.outbound.retry.no_prestataire')
      return
    }
    await this.prisma.$transaction(async (tx) => {
      await this.transfers.resetToPendingForRetryTx(tx, { transferId })
    })
    const fresh = (await this.transfers.findById(transferId)) as Transfer
    await this.callStripeTransfer({
      transferRow: fresh,
      payment,
      mission: payment.mission,
      prestataire: payment.mission.prestataire,
      trigger: 'RETRY_JOB',
    })
  }

  async retryFromAdmin(transferId: string, adminUserId: string): Promise<void> {
    const row = await this.transfers.findById(transferId)
    if (!row) throw new Error('transfer_not_found')
    if (row.status !== 'FAILED' && row.status !== 'RETRY_SCHEDULED') {
      throw new Error('transfer_not_retryable_state')
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.transfer.updateMany({
        where: { id: transferId, status: { in: ['FAILED', 'RETRY_SCHEDULED'] } },
        data: { status: 'PENDING', failureCode: null, failureReason: null },
      })
    })
    const payment = await this.prisma.payment.findUnique({
      where: { id: row.paymentId },
      include: { mission: { include: { prestataire: true } } },
    })
    if (!payment?.mission.prestataire) throw new Error('prestataire_missing')
    await this.missionEvents.record({
      missionId: payment.missionId,
      type: 'TRANSFER_ADMIN_RETRY_REQUESTED',
      actorUserId: adminUserId,
      payload: { transferId, paymentId: payment.id },
    })
    const fresh = (await this.transfers.findById(transferId)) as Transfer
    await this.callStripeTransfer({
      transferRow: fresh,
      payment,
      mission: payment.mission,
      prestataire: payment.mission.prestataire,
      trigger: 'ADMIN_RETRY',
    })
  }

  async reconcileTransferRow(transferId: string): Promise<void> {
    const row = await this.transfers.findById(transferId)
    if (!row?.stripeTransferId) return
    const remote = await this.stripeMetrics.time('transfers.retrieve', () =>
      this.stripe.transfers.retrieve(row.stripeTransferId as string),
    )
    await this.applyRemoteTransferState(row.id, remote)
  }

  private async executeOutboundTransfer(
    paymentId: string,
    trigger: Extract<OutboundTransferTrigger, 'PAYMENT_CAPTURE_WEBHOOK'>,
  ): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        mission: { include: { prestataire: true } },
        transfer: true,
      },
    })
    if (!payment) {
      this.logger.warn({ paymentId }, 'transfer.outbound.payment_not_found')
      return
    }
    if (payment.status !== 'CAPTURED') {
      this.logger.log({ paymentId, status: payment.status }, 'transfer.outbound.skip_not_captured')
      return
    }
    if (payment.mission.status !== 'COMPLETED') {
      this.logger.log(
        { paymentId, missionId: payment.missionId, missionStatus: payment.mission.status },
        'transfer.outbound.skip_mission_not_completed',
      )
      return
    }
    if (!payment.mission.prestataireId || !payment.mission.prestataire) {
      this.logger.warn({ paymentId }, 'transfer.outbound.skip_no_prestataire')
      return
    }
    if (payment.providerPayoutCents === null || payment.providerPayoutCents <= 0) {
      this.logger.error({ paymentId }, 'transfer.outbound.skip_invalid_provider_payout_snapshot')
      return
    }
    const providerPayoutCents = payment.providerPayoutCents

    this.assertPrestatairePayoutReady(payment.mission.prestataire)

    const existing = payment.transfer
    if (existing) {
      if (existing.status === 'SENT') {
        this.logger.log({ transferId: existing.id }, 'transfer.outbound.idempotent_already_sent')
        return
      }
      if (existing.status === 'PENDING' || existing.status === 'RETRY_SCHEDULED') {
        this.logger.log({ transferId: existing.id, status: existing.status }, 'transfer.outbound.skip_existing_row')
        return
      }
      if (existing.status === 'FAILED' || existing.status === 'REVERSED') {
        this.logger.warn({ transferId: existing.id, status: existing.status }, 'transfer.outbound.skip_terminal_row')
        return
      }
    }

    const idempotencyKey = buildTransferStripeIdempotencyKey(payment.missionId)
    let transferRow = existing ?? null
    if (!transferRow) {
      const created = await this.prisma.$transaction(async (tx) => {
        return this.transfers.tryInsertPendingTx(tx, {
          paymentId: payment.id,
          amountCents: providerPayoutCents,
          currency: payment.currency,
          idempotencyKey,
        })
      })
      if (!created) {
        const again = await this.prisma.payment.findUnique({
          where: { id: paymentId },
          include: { transfer: true },
        })
        transferRow = again?.transfer ?? null
        if (!transferRow) return
        if (transferRow.status === 'SENT' || transferRow.status === 'PENDING' || transferRow.status === 'RETRY_SCHEDULED') {
          this.logger.log({ transferId: transferRow.id }, 'transfer.outbound.concurrent_insert')
          return
        }
      } else {
        transferRow = created
      }
    }

    await this.callStripeTransfer({
      transferRow: transferRow as Transfer,
      payment,
      mission: payment.mission,
      prestataire: payment.mission.prestataire,
      trigger,
    })
  }

  private assertPrestatairePayoutReady(p: User): void {
    if (p.providerPayoutStatus !== 'READY') {
      throw new TransferPayoutNotReadyError(String(p.providerPayoutStatus))
    }
    if (p.stripeAccountId === null || p.stripeAccountId.length === 0) {
      throw new TransferPayoutNotReadyError('MISSING_STRIPE_ACCOUNT')
    }
    if (p.stripeTransfersEnabled !== true) {
      throw new TransferPayoutNotReadyError('TRANSFERS_DISABLED')
    }
    if (p.stripePayoutsEnabled !== true) {
      throw new TransferPayoutNotReadyError('PAYOUTS_DISABLED')
    }
    if (p.stripeChargesEnabled !== true) {
      throw new TransferPayoutNotReadyError('CHARGES_DISABLED')
    }
  }

  private async callStripeTransfer(opts: {
    transferRow: Transfer
    payment: Payment & { mission: Mission & { prestataire: User | null } }
    mission: Mission
    prestataire: User
    trigger: OutboundTransferTrigger
  }): Promise<void> {
    const { transferRow, payment, mission, prestataire } = opts
    const idempotencyKey = buildTransferStripeIdempotencyKey(mission.id)

    let latestCharge: string | null = null
    try {
      const pi = await this.stripeMetrics.time('payment_intents.retrieve', () =>
        this.stripe.paymentIntents.retrieve(payment.stripePaymentIntentId),
      )
      const lc = pi.latest_charge
      latestCharge = typeof lc === 'string' ? lc : lc && typeof lc === 'object' && 'id' in lc ? lc.id : null
    } catch (e) {
      await this.recordFailure(transferRow.id, 'pi_retrieve_failed', e)
      return
    }
    if (!latestCharge) {
      await this.recordFailure(transferRow.id, 'missing_latest_charge', new Error('no charge'))
      return
    }

    try {
      this.assertPrestatairePayoutReady(prestataire)

      const payoutCents = payment.providerPayoutCents
      if (payoutCents === null || payoutCents <= 0) {
        await this.recordFailure(transferRow.id, 'missing_provider_payout_snapshot', new Error('no payout'))
        return
      }

      const tr = await this.stripeMetrics.time('transfers.create', () =>
        this.stripe.transfers.create(
          {
            amount: payoutCents,
            currency: payment.currency,
            destination: prestataire.stripeAccountId as string,
            transfer_group: mission.missionNumber,
            source_transaction: latestCharge,
            metadata: {
              mission_id: mission.id,
              payment_id: payment.id,
            },
          },
          { idempotencyKey },
        ),
      )

      await this.prisma.$transaction(async (tx) => {
        await this.transfers.updateStripeTransferIdTx(tx, {
          transferId: transferRow.id,
          stripeTransferId: tr.id,
        })
        const sent = await this.transfers.transitionToSentTx(tx, {
          transferId: transferRow.id,
          stripeTransferId: tr.id,
        })
        if (sent === 1) {
          await this.missionEvents.recordTx(tx, {
            missionId: mission.id,
            type: 'TRANSFER_SENT',
            actorUserId: null,
            payload: {
              transferId: transferRow.id,
              stripeTransferId: tr.id,
              amountCents: tr.amount,
              trigger: opts.trigger,
            },
          })
        }
      })

      this.logger.log(
        { transferId: transferRow.id, stripeTransferId: tr.id, missionId: mission.id },
        'transfer.outbound.stripe_created',
      )

      const refreshed = await this.stripeMetrics.time('transfers.retrieve', () =>
        this.stripe.transfers.retrieve(tr.id),
      )
      await this.applyRemoteTransferState(transferRow.id, refreshed)
    } catch (err) {
      if (err instanceof TransferPayoutNotReadyError) {
        this.logger.warn({ missionId: mission.id, reason: err.reason }, 'transfer.outbound.payout_not_ready_call')
        return
      }
      await this.recordFailure(transferRow.id, 'stripe_transfers_create_failed', err)
    }
  }

  /**
   * Persiste l'échec API + déclenche la suite (retry auto ou terminal).
   *
   * Politique CTO PRD-004 Ticket 4.2 :
   *  1. Classifie l'erreur Stripe (transient / permanent / unknown).
   *  2. Permanent → `Transfer.FAILED` terminal direct (force `retryCount = max`)
   *     + métrique `retry_exhausted{reason=permanent_error}` + alerte P1
   *     (action admin requise pour retry manuel).
   *  3. Transient / unknown → incrément `retryCount`, si `< max` enqueue
   *     `TRANSFER_RETRY_QUEUE` avec backoff + jitter. Si `>= max` →
   *     terminal + métrique `retry_exhausted{reason=transient_max_attempts}`
   *     + alerte P0 (prestataire pas payé après 5 essais).
   *
   * Idempotence : `markFailureTx` calcule la nouvelle ligne en SQL via
   * `WHERE` sur le `retryCount` actuel — pas de double comptage si la
   * fonction est rejouée par un cron safety-net.
   */
  private async recordFailure(transferId: string, code: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err)
    const classified = classifyStripeTransferError(err)

    type FailureState = { next: number; terminal: boolean; missionId: string | null }
    const state: FailureState = await this.prisma.$transaction(async (tx): Promise<FailureState> => {
      const row = await tx.transfer.findUnique({
        where: { id: transferId },
        include: { payment: { select: { missionId: true } } },
      })
      if (!row) return { next: 0, terminal: false, missionId: null }
      let nextCount: number
      let isTerminal: boolean
      if (classified.kind === 'permanent') {
        nextCount = TRANSFER_MAX_API_ATTEMPTS
        isTerminal = true
      } else {
        nextCount = row.retryCount + 1
        isTerminal = nextCount >= TRANSFER_MAX_API_ATTEMPTS
      }
      await this.transfers.markFailureTx(tx, {
        transferId,
        failureCode: classified.code === 'unknown' ? code : classified.code,
        failureReason: msg,
        nextRetryCount: nextCount,
        maxAttempts: TRANSFER_MAX_API_ATTEMPTS,
      })
      return { next: nextCount, terminal: isTerminal, missionId: row.payment.missionId }
    })
    const { next, terminal, missionId: missionIdForAlert } = state

    if (terminal) {
      const reason =
        classified.kind === 'permanent' ? 'permanent_error' : 'transient_max_attempts'
      this.retryMetrics.recordExhausted({
        queue: TRANSFER_RETRY_QUEUE,
        jobType: 'transfer_payout',
        reason,
      })
      this.logger.error(
        { transferId, next, classified, code: classified.code },
        'transfer.outbound.failed_terminal',
      )
      // Alerting non bloquant — `AlertingService.emit` ne throw jamais.
      // CTO : P0 sur transient exhausted (impact direct prestataire),
      //       P1 sur permanent (action admin attendue, pas critique).
      const severity = classified.kind === 'permanent' ? 'P1' : 'P0'
      const kind = classified.kind === 'permanent' ? 'stuck_transfer' : 'bullmq_failed_jobs'
      void this.alerting.emit({
        severity,
        kind,
        title: `Transfer FAILED terminal (${reason})`,
        description: `transfer ${transferId.slice(0, 8)}… exhausted after ${next} attempts (code=${classified.code})`,
        context: {
          // Aucun email/PII. transferId/missionId tronqués pour logs uniquement.
          transferIdShort: transferId.slice(0, 8),
          missionIdShort: missionIdForAlert?.slice(0, 8) ?? null,
          attempts: next,
          stripeStatusCode: classified.statusCode,
          stripeCode: classified.code,
          reason,
        },
      })
      return
    }

    // Retry automatique — file dédiée, idempotency Stripe stable.
    await this.retryQueue.enqueue({ transferId, attempt: next })
    this.logger.warn(
      { transferId, attempt: next, code: classified.code, kind: classified.kind },
      'transfer.outbound.retry_enqueued',
    )
  }

  async applyRemoteTransferState(transferDbId: string, remote: Stripe.Transfer): Promise<void> {
    if (remote.reversed || remote.amount_reversed > 0) {
      await this.prisma.$transaction(async (tx) => {
        const n = await this.transfers.transitionToReversedTx(tx, { transferId: transferDbId })
        if (n !== 1) return
        const row = await tx.transfer.findUnique({ where: { id: transferDbId }, include: { payment: true } })
        if (!row?.payment) return
        const m = await tx.mission.findUnique({ where: { id: row.payment.missionId } })
        if (m?.status === 'COMPLETED') {
          assertMissionTransition('COMPLETED', 'DISPUTE_OPEN')
        }
        const updated = await this.missions.transitionCompletedToDisputeOpenTx(tx, {
          missionId: row.payment.missionId,
        })
        if (updated === 1) {
          await this.missionEvents.recordTx(tx, {
            missionId: row.payment.missionId,
            type: 'TRANSFER_REVERSED',
            actorUserId: null,
            payload: {
              transferId: transferDbId,
              stripeTransferId: remote.id,
              amountReversed: remote.amount_reversed,
            },
          })
        }
      })
      return
    }

    await this.prisma.$transaction(async (tx) => {
      await this.transfers.transitionToSentTx(tx, {
        transferId: transferDbId,
        stripeTransferId: remote.id,
      })
    })
  }

  /** Cron quotidien CTO — Transfers `PENDING` / `RETRY_SCHEDULED` sans update > 2 h (webhook manquant). */
  async reconcileStaleTransfersBatch(): Promise<void> {
    const cutoff = new Date(Date.now() - TRANSFER_RECONCILE_STALE_MS)
    const rows = await this.transfers.findStaleNonTerminal({ olderThan: cutoff, limit: 100 })
    for (const r of rows) {
      if (!r.stripeTransferId) continue
      try {
        await this.reconcileTransferRow(r.id)
      } catch (err) {
        this.logger.warn(
          { transferId: r.id, err: err instanceof Error ? err.message : 'unknown' },
          'transfer.reconcile.row_failed',
        )
      }
    }
  }
}

export class TransferPayoutNotReadyError extends Error {
  constructor(readonly reason: string) {
    super(`prestataire_payout_not_ready:${reason}`)
    this.name = 'TransferPayoutNotReadyError'
  }
}
