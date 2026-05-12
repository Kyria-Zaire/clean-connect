import { Injectable } from '@nestjs/common'
import { Prisma, type Transfer, type TransferStatus } from '@prisma/client'

import { PrismaService } from '../../../common/prisma/prisma.service'

@Injectable()
export class TransfersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByPaymentId(paymentId: string): Promise<Transfer | null> {
    return this.prisma.transfer.findUnique({ where: { paymentId } })
  }

  findByStripeTransferId(stripeTransferId: string): Promise<Transfer | null> {
    return this.prisma.transfer.findUnique({ where: { stripeTransferId } })
  }

  /**
   * Liste transfers « stale » pour réconciliation cron (Ticket 3.5 CTO) :
   * statuts non terminaux + `updatedAt` ancien.
   */
  async findStaleNonTerminal(opts: { olderThan: Date; limit: number }): Promise<Transfer[]> {
    return this.prisma.transfer.findMany({
      where: {
        status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
        updatedAt: { lte: opts.olderThan },
      },
      take: opts.limit,
      orderBy: { updatedAt: 'asc' },
    })
  }

  async listForAdmin(opts: { limit: number; cursor?: string; status?: TransferStatus }): Promise<Transfer[]> {
    return this.prisma.transfer.findMany({
      where: opts.status ? { status: opts.status } : {},
      include: { payment: { select: { missionId: true, status: true, stripePaymentIntentId: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  /**
   * Crée la ligne `Transfer` initiale (1:1 payment) — idempotent via unique `paymentId`.
   * Retourne `null` si une ligne existe déjà (race / replay).
   */
  async tryInsertPendingTx(
    tx: Prisma.TransactionClient,
    input: {
      paymentId: string
      amountCents: number
      currency: string
      idempotencyKey: string
    },
  ): Promise<Transfer | null> {
    try {
      return await tx.transfer.create({
        data: {
          paymentId: input.paymentId,
          amountCents: input.amountCents,
          currency: input.currency,
          status: 'PENDING',
          idempotencyKey: input.idempotencyKey,
        },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return null
      }
      throw e
    }
  }

  async updateStripeTransferIdTx(
    tx: Prisma.TransactionClient,
    opts: { transferId: string; stripeTransferId: string },
  ): Promise<number> {
    const r = await tx.transfer.updateMany({
      where: { id: opts.transferId, stripeTransferId: null },
      data: { stripeTransferId: opts.stripeTransferId },
    })
    return r.count
  }

  async transitionToSentTx(
    tx: Prisma.TransactionClient,
    opts: { transferId: string; stripeTransferId: string },
  ): Promise<number> {
    const r = await tx.transfer.updateMany({
      where: {
        id: opts.transferId,
        status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
      },
      data: { status: 'SENT', stripeTransferId: opts.stripeTransferId },
    })
    return r.count
  }

  async transitionToReversedTx(tx: Prisma.TransactionClient, opts: { transferId: string }): Promise<number> {
    const r = await tx.transfer.updateMany({
      where: { id: opts.transferId, status: { in: ['PENDING', 'SENT', 'RETRY_SCHEDULED'] } },
      data: { status: 'REVERSED' },
    })
    return r.count
  }

  /**
   * Marque un échec API Stripe — si `retryCount` >= max → `FAILED` terminal.
   */
  async markFailureTx(
    tx: Prisma.TransactionClient,
    opts: {
      transferId: string
      failureCode: string
      failureReason: string
      nextRetryCount: number
      maxAttempts: number
    },
  ): Promise<{ status: TransferStatus }> {
    const terminal = opts.nextRetryCount >= opts.maxAttempts
    const status: TransferStatus = terminal ? 'FAILED' : 'RETRY_SCHEDULED'
    await tx.transfer.update({
      where: { id: opts.transferId },
      data: {
        status,
        retryCount: opts.nextRetryCount,
        lastRetryAt: new Date(),
        failureCode: opts.failureCode.slice(0, 120),
        failureReason: opts.failureReason.slice(0, 4_000),
      },
    })
    return { status }
  }

  /** Repasse en `PENDING` avant une nouvelle tentative Stripe (retry job). */
  async resetToPendingForRetryTx(tx: Prisma.TransactionClient, opts: { transferId: string }): Promise<number> {
    const r = await tx.transfer.updateMany({
      where: { id: opts.transferId, status: 'RETRY_SCHEDULED' },
      data: { status: 'PENDING' },
    })
    return r.count
  }

  async findById(id: string): Promise<Transfer | null> {
    return this.prisma.transfer.findUnique({ where: { id } })
  }
}
