/**
 * PRD-003 Ticket 3.5 — Remboursement intégral MVP (ADMIN uniquement).
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type Stripe from 'stripe'

import { loadEnv } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { MissionEventService } from '../../missions/services/mission-event.service'
import { StripeMetricsTracker } from '../../observability/metrics/stripe-metrics.tracker'
import {
  PaymentInvalidStateException,
  PaymentPartialRefundNotSupportedException,
  PaymentRefundBlockedTransferSentException,
  PaymentsDisabledException,
} from '../payments.errors'
import { STRIPE_CLIENT_TOKEN } from '../stripe/stripe.client'

import { RefundsRepository } from './refunds.repository'

function buildRefundIdempotencyKey(missionId: string, attempt: number): string {
  return `refund-mission-${missionId}-${attempt}`
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name)
  private readonly paymentsEnabled: boolean

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsRepository,
    private readonly missionEvents: MissionEventService,
    private readonly stripeMetrics: StripeMetricsTracker,
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe: Stripe,
  ) {
    this.paymentsEnabled = loadEnv().FF_PAYMENTS_ENABLED
  }

  /**
   * ADMIN — remboursement **intégral** uniquement (`amountCents === amountCapturedCents`).
   * Interdit si `Transfer.status === SENT` (CTO 3.5 — workflow manuel Stripe Dashboard sinon).
   */
  async adminCreateFullRefund(opts: {
    paymentId: string
    adminUserId: string
    /** Body admin — `amountCents` optionnel ; si fourni doit matcher le capturé. */
    amountCents?: number
  }): Promise<{ accepted: true; refundId: string; stripeRefundId: string | null }> {
    if (!this.paymentsEnabled) throw new PaymentsDisabledException()

    const payment = await this.prisma.payment.findUnique({
      where: { id: opts.paymentId },
      include: { transfer: true, refunds: true },
    })
    if (!payment) throw new PaymentInvalidStateException('payment_not_found')
    if (payment.status !== 'CAPTURED') {
      throw new PaymentInvalidStateException(`payment_must_be_CAPTURED (current: ${payment.status})`)
    }
    const captured = payment.amountCapturedCents
    if (captured === null || captured <= 0) {
      throw new PaymentInvalidStateException('payment_missing_amount_captured')
    }
    if (opts.amountCents !== undefined && opts.amountCents !== captured) {
      throw new PaymentPartialRefundNotSupportedException()
    }

    if (payment.transfer?.status === 'SENT') {
      throw new PaymentRefundBlockedTransferSentException()
    }

    const existingSucceeded = payment.refunds.some((r) => r.status === 'REFUNDED')
    if (existingSucceeded) {
      throw new PaymentInvalidStateException('payment_already_refunded')
    }
    if (payment.refunds.some((r) => r.status === 'PENDING')) {
      throw new PaymentInvalidStateException('refund_already_in_progress')
    }

    const attempt = payment.refunds.length + 1
    const idempotencyKey = buildRefundIdempotencyKey(payment.missionId, attempt)

    const refundRow = await this.prisma.$transaction(async (tx) => {
      return this.refunds.createPendingTx(tx, {
        paymentId: payment.id,
        idempotencyKey,
        amountCents: captured,
        currency: payment.currency,
        initiatedBy: `admin:${opts.adminUserId}`,
      })
    })

    try {
      const rf = await this.stripeMetrics.time('refunds.create', () =>
        this.stripe.refunds.create(
          {
            payment_intent: payment.stripePaymentIntentId,
            amount: captured,
            metadata: {
              mission_id: payment.missionId,
              payment_id: payment.id,
              refund_id: refundRow.id,
            },
          },
          { idempotencyKey },
        ),
      )

      if (rf.status === 'succeeded' || rf.status === 'pending') {
        // Source de vérité finale = webhook `refund.updated` (CTO). On persiste l'id Stripe pour corrélation.
        await this.prisma.refund.update({
          where: { id: refundRow.id },
          data: { stripeRefundId: rf.id },
        })
      }

      await this.missionEvents.record({
        missionId: payment.missionId,
        type: 'REFUND_ADMIN_REQUESTED',
        actorUserId: opts.adminUserId,
        payload: {
          refundId: refundRow.id,
          stripeRefundId: rf.id,
          amountCents: captured,
          stripeStatus: rf.status,
        },
      })

      this.logger.log(
        { refundId: refundRow.id, stripeRefundId: rf.id, paymentId: payment.id },
        'refunds.admin.stripe_refund_created',
      )

      return { accepted: true as const, refundId: refundRow.id, stripeRefundId: rf.id }
    } catch (err) {
      await this.prisma.$transaction(async (tx) => {
        await this.refunds.markFailedTx(tx, {
          refundId: refundRow.id,
          failureCode: 'stripe_refund_create_failed',
          failureReason: err instanceof Error ? err.message : String(err),
        })
      })
      throw err
    }
  }
}
