/**
 * PRD-003 Ticket 3.2 — `PaymentsRepository`.
 *
 * Accès Prisma typé pour `Payment` + `MissionEvent` côté paiement. Aucune
 * logique métier ici (rule architecte-api §découpage).
 *
 * Notes idempotence :
 *  - `findByIdempotencyKey` consomme l'unique index `payments_idempotency_key_key`
 *    (cf. migration 20260512240000).
 *  - `createPendingPaymentTx` est appelé EN TRANSACTION avec la transition
 *    `Mission DRAFT → PENDING_PAYMENT` côté `MissionsRepository.transitionDraftToPendingPaymentTx`.
 */

import { Injectable } from '@nestjs/common'
import type { Payment, Prisma } from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'

export interface PaymentInsertInput {
  missionId: string
  stripePaymentIntentId: string
  idempotencyKey: string
  amountAuthorizedCents: number
  applicationFeeCents: number
  providerPayoutCents: number
  currency: string
}

export interface PaymentListPaginatedOpts {
  limit: number
  cursor?: string
  status?: Payment['status']
}

export interface AdminPaymentListPaginatedOpts extends PaymentListPaginatedOpts {
  clientId?: string
  missionId?: string
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { idempotencyKey } })
  }

  findByMissionId(missionId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { missionId } })
  }

  findByStripePaymentIntentId(stripePaymentIntentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { stripePaymentIntentId } })
  }

  /**
   * Insert d'un Payment en état `AUTHORIZATION_PENDING` — appelé après création
   * du PaymentIntent côté Stripe. Snapshot des montants immutables (commission
   * lock-in cf. ADR-008 §4).
   */
  async createPendingPaymentTx(
    tx: Prisma.TransactionClient,
    input: PaymentInsertInput,
  ): Promise<Payment> {
    return tx.payment.create({
      data: {
        missionId: input.missionId,
        stripePaymentIntentId: input.stripePaymentIntentId,
        idempotencyKey: input.idempotencyKey,
        amountAuthorizedCents: input.amountAuthorizedCents,
        applicationFeeCents: input.applicationFeeCents,
        providerPayoutCents: input.providerPayoutCents,
        currency: input.currency,
        status: 'AUTHORIZATION_PENDING',
      },
    })
  }

  /**
   * Transition `AUTHORIZATION_PENDING → AUTHORIZED` (webhook
   * `payment_intent.amount_capturable_updated`). Lock idempotent : 0 si déjà
   * autorisé (replay webhook), 1 si transition appliquée.
   */
  async transitionPendingToAuthorizedTx(
    tx: Prisma.TransactionClient,
    opts: { paymentId: string },
  ): Promise<number> {
    const result = await tx.payment.updateMany({
      where: { id: opts.paymentId, status: 'AUTHORIZATION_PENDING' },
      data: { status: 'AUTHORIZED' },
    })
    return result.count
  }

  /**
   * Webhook `payment_intent.payment_failed` — passage `*_PENDING → FAILED`
   * avec failureCode/Message Stripe. Idempotent : ne touche pas si déjà FAILED.
   */
  async markFailedTx(
    tx: Prisma.TransactionClient,
    opts: {
      paymentId: string
      failureCode: string | null
      failureMessage: string | null
    },
  ): Promise<number> {
    const result = await tx.payment.updateMany({
      where: { id: opts.paymentId, status: { in: ['AUTHORIZATION_PENDING'] } },
      data: {
        status: 'FAILED',
        failureCode: opts.failureCode,
        failureMessage: opts.failureMessage,
      },
    })
    return result.count
  }

  /**
   * PRD-003 Ticket 3.4 — webhook `payment_intent.succeeded` :
   * passage `AUTHORIZED → CAPTURED`. Idempotent (replay webhook : 0 row si
   * déjà `CAPTURED`). Persiste `amountCapturedCents` (Stripe expose
   * `amount_received`).
   *
   * Notes :
   *  - On accepte aussi un statut entrant `AUTHORIZATION_PENDING` car Stripe
   *    peut, dans certains chemins SetupIntent/Apple Pay, sauter le webhook
   *    `amount_capturable_updated` (le `succeeded` arrive directement après
   *    la capture). On absorbe ce cas pour rester aligné Stripe API contract.
   */
  async transitionAuthorizedToCapturedTx(
    tx: Prisma.TransactionClient,
    opts: { paymentId: string; amountCapturedCents: number },
  ): Promise<number> {
    const result = await tx.payment.updateMany({
      where: {
        id: opts.paymentId,
        status: { in: ['AUTHORIZATION_PENDING', 'AUTHORIZED'] },
      },
      data: {
        status: 'CAPTURED',
        amountCapturedCents: opts.amountCapturedCents,
      },
    })
    return result.count
  }

  /**
   * Webhook `payment_intent.canceled` — passage `*_PENDING|AUTHORIZED → CANCELLED`.
   * `failureCode='authorization_expired'` si Stripe a déclenché la cancellation
   * automatique après 7 j sans capture (rev2 state machines).
   */
  async markCancelledTx(
    tx: Prisma.TransactionClient,
    opts: {
      paymentId: string
      failureCode: string | null
      failureMessage: string | null
    },
  ): Promise<number> {
    const result = await tx.payment.updateMany({
      where: {
        id: opts.paymentId,
        status: { in: ['AUTHORIZATION_PENDING', 'AUTHORIZED'] },
      },
      data: {
        status: 'CANCELLED',
        failureCode: opts.failureCode,
        failureMessage: opts.failureMessage,
      },
    })
    return result.count
  }

  // ---------------------------------------------------------------------------
  // Listings (cursor-based, alignement `missionListQuery`)
  // ---------------------------------------------------------------------------

  async listForClient(opts: {
    clientId: string
    limit: number
    cursor?: string
    status?: Payment['status']
  }): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: {
        mission: { clientId: opts.clientId },
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  async listForAdmin(opts: AdminPaymentListPaginatedOpts): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.missionId ? { missionId: opts.missionId } : {}),
        ...(opts.clientId ? { mission: { clientId: opts.clientId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }
}
