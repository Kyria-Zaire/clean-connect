/**
 * PRD-003 Ticket 3.5 — Webhooks `refund.updated` (succès / échec).
 */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type Stripe from 'stripe'

import type { Env } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { PaymentsRepository } from '../payments.repository'
import { RefundsRepository } from '../refunds/refunds.repository'

import { PaymentDomainLivemodeMismatchError } from './payment-domain-livemode.error'

export const REFUND_DOMAIN_EVENT_TYPES = new Set<string>(['refund.updated'])

@Injectable()
export class RefundDomainHandler {
  private readonly logger = new Logger(RefundDomainHandler.name)
  private readonly appEnvIsProduction: boolean

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsRepository,
    private readonly refunds: RefundsRepository,
    config: ConfigService<Env, true>,
  ) {
    this.appEnvIsProduction = config.get('APP_ENV', { infer: true }) === 'production'
  }

  shouldHandle(type: string): boolean {
    return REFUND_DOMAIN_EVENT_TYPES.has(type)
  }

  async handle(event: Stripe.Event): Promise<void> {
    this.assertLivemode(event)
    const rf = event.data.object as Stripe.Refund
    if (rf.status === 'succeeded') {
      await this.onSucceeded(rf)
      return
    }
    if (rf.status === 'failed' || rf.status === 'canceled') {
      await this.onFailed(rf)
    }
  }

  private assertLivemode(event: Stripe.Event): void {
    if (event.livemode !== this.appEnvIsProduction) {
      throw new PaymentDomainLivemodeMismatchError(
        event.id,
        event.livemode,
        this.appEnvIsProduction,
      )
    }
  }

  private async onSucceeded(rf: Stripe.Refund): Promise<void> {
    const row = await this.refunds.findByStripeRefundId(rf.id)
    if (!row) {
      this.logger.warn({ stripeRefundId: rf.id }, 'refund.domain.refund_row_not_found')
      return
    }
    if (row.status === 'REFUNDED') {
      this.logger.log({ refundId: row.id }, 'refund.domain.succeeded.idempotent_skip')
      return
    }

    await this.prisma.$transaction(async (tx) => {
      const ok = await this.refunds.markSucceededTx(tx, { refundId: row.id, stripeRefundId: rf.id })
      if (ok !== 1) return
      await this.payments.transitionCapturedToRefundedTx(tx, { paymentId: row.paymentId })
    })

    this.logger.log({ refundId: row.id, stripeRefundId: rf.id }, 'refund.domain.succeeded.processed')
  }

  private async onFailed(rf: Stripe.Refund): Promise<void> {
    const row = await this.refunds.findByStripeRefundId(rf.id)
    if (!row) return
    await this.prisma.$transaction(async (tx) => {
      await this.refunds.markFailedTx(tx, {
        refundId: row.id,
        failureCode: rf.failure_reason ?? 'refund_failed',
        failureReason: String(rf.status),
      })
    })
    this.logger.warn({ refundId: row.id, stripeRefundId: rf.id }, 'refund.domain.failed.processed')
  }
}
