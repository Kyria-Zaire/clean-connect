/**
 * PRD-003 Ticket 3.5 — Routing webhooks Stripe `transfer.*`.
 *
 * Note produit : Stripe n'expose pas d'event `transfer.succeeded` — la réussite
 * est portée par `transfer.created` / `transfer.updated` + champ `reversed`.
 * Le CTO Ticket 3.5 parle sémantiquement de « succeeded » : implémenté via
 * `OutboundTransferService.applyRemoteTransferState` (alignement état `SENT`).
 */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type Stripe from 'stripe'

import type { Env } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { OutboundTransferService } from '../transfers/outbound-transfer.service'
import { TransfersRepository } from '../transfers/transfers.repository'

import { PaymentDomainLivemodeMismatchError } from './payment-domain-livemode.error'

export const TRANSFER_DOMAIN_EVENT_TYPES = new Set<string>([
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
])

@Injectable()
export class TransferDomainHandler {
  private readonly logger = new Logger(TransferDomainHandler.name)

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly transfers: TransfersRepository,
    private readonly outbound: OutboundTransferService,
  ) {}

  shouldHandle(type: string): boolean {
    return TRANSFER_DOMAIN_EVENT_TYPES.has(type)
  }

  async handle(event: Stripe.Event): Promise<void> {
    this.assertLivemode(event)
    switch (event.type) {
      case 'transfer.created':
      case 'transfer.updated':
        await this.onCreatedOrUpdated(event.data.object as Stripe.Transfer)
        return
      case 'transfer.reversed':
        // Stripe `Event.data.object` est typé `Transfer` par défaut ; `transfer.reversed` = TransferReversal.
        await this.onReversed(event.data.object as unknown as Stripe.TransferReversal)
        return
      default:
        this.logger.warn({ type: event.type }, 'transfer.domain.unknown_event_type')
    }
  }

  private assertLivemode(event: Stripe.Event): void {
    const isProd = this.config.get('APP_ENV', { infer: true }) === 'production'
    if (event.livemode !== isProd) {
      throw new PaymentDomainLivemodeMismatchError(event.id, event.livemode, isProd)
    }
  }

  private async onCreatedOrUpdated(remote: Stripe.Transfer): Promise<void> {
    let row = await this.transfers.findByStripeTransferId(remote.id)
    if (!row && remote.metadata?.['mission_id']) {
      const missionId = String(remote.metadata['mission_id'])
      const payment = await this.prisma.payment.findUnique({ where: { missionId } })
      if (payment) {
        row = await this.transfers.findByPaymentId(payment.id)
      }
    }
    if (!row) {
      this.logger.warn({ stripeTransferId: remote.id }, 'transfer.domain.row_not_found')
      return
    }
    await this.outbound.applyRemoteTransferState(row.id, remote)
  }

  /**
   * `transfer.reversed` — payload = objet **TransferReversal** (pas `Transfer`).
   * On résout le parent `transfer` via l'API Stripe pour aligner l'état DB.
   */
  private async onReversed(reversal: Stripe.TransferReversal): Promise<void> {
    const parentId =
      typeof reversal.transfer === 'string' ? reversal.transfer : reversal.transfer?.id
    if (!parentId) {
      this.logger.warn({ reversalId: reversal.id }, 'transfer.reversed.missing_parent')
      return
    }
    const row = await this.transfers.findByStripeTransferId(parentId)
    if (!row) {
      this.logger.warn({ stripeTransferId: parentId }, 'transfer.reversed.transfer_row_not_found')
      return
    }
    // Re-fetch Transfer parent (source de vérité) — petit coût, idempotent.
    // Inject Stripe in handler would couple — use OutboundTransferService public method:
    await this.outbound.reconcileTransferRow(row.id)
  }
}
