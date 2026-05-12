import { Injectable } from '@nestjs/common'
import type { Prisma, Refund, RefundStatus } from '@prisma/client'

import { PrismaService } from '../../../common/prisma/prisma.service'

@Injectable()
export class RefundsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByPaymentId(paymentId: string): Promise<Refund[]> {
    return this.prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } })
  }

  findByStripeRefundId(stripeRefundId: string): Promise<Refund | null> {
    return this.prisma.refund.findUnique({ where: { stripeRefundId } })
  }

  async listForAdmin(opts: { limit: number; cursor?: string; status?: RefundStatus }): Promise<Refund[]> {
    return this.prisma.refund.findMany({
      where: opts.status ? { status: opts.status } : {},
      include: { payment: { select: { missionId: true, status: true, stripePaymentIntentId: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  async createPendingTx(
    tx: Prisma.TransactionClient,
    input: {
      paymentId: string
      idempotencyKey: string
      amountCents: number
      currency: string
      initiatedBy: string
    },
  ): Promise<Refund> {
    return tx.refund.create({
      data: {
        paymentId: input.paymentId,
        idempotencyKey: input.idempotencyKey,
        amountCents: input.amountCents,
        currency: input.currency,
        status: 'PENDING',
        initiatedBy: input.initiatedBy,
      },
    })
  }

  async markSucceededTx(
    tx: Prisma.TransactionClient,
    opts: { refundId: string; stripeRefundId: string },
  ): Promise<number> {
    const r = await tx.refund.updateMany({
      where: { id: opts.refundId, status: 'PENDING' },
      data: { status: 'REFUNDED', stripeRefundId: opts.stripeRefundId, settledAt: new Date() },
    })
    return r.count
  }

  async markFailedTx(
    tx: Prisma.TransactionClient,
    opts: { refundId: string; failureCode: string; failureReason: string },
  ): Promise<number> {
    const r = await tx.refund.updateMany({
      where: { id: opts.refundId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        failureCode: opts.failureCode.slice(0, 120),
        failureReason: opts.failureReason.slice(0, 4_000),
      },
    })
    return r.count
  }
}
