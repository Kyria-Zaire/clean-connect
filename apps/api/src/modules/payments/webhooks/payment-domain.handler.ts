/**
 * PRD-003 Ticket 3.2 — Routing métier des events `payment_intent.*`.
 *
 * Appelé depuis `StripeWebhookProcessor` après le verrou applicatif. Le payload
 * authentifié est **re-fetché** via `stripe.events.retrieve(eventId)` (jamais
 * sourcé depuis Redis — rule securite, audit Verify V1).
 *
 * Events gérés en 3.2 (autres = Tickets 3.3 → 3.5, marqués `PROCESSED` sans
 * routing) :
 *   - `payment_intent.amount_capturable_updated` → `Payment.AUTHORIZED`
 *     + `Mission PENDING_PAYMENT → PUBLISHED` (+ matching async).
 *   - `payment_intent.payment_failed` → `Payment.FAILED` (mission RESTE en
 *     `PENDING_PAYMENT` pour permettre un retry client).
 *   - `payment_intent.canceled` → `Payment.CANCELLED` + `Mission PENDING_PAYMENT
 *     → CANCELLED`. Si `cancellation_reason='automatic'` → failureCode marqué
 *     `authorization_expired` (préparation Ticket 3.4 — rev2 state machines).
 *
 * Idempotence forte (replay webhook) :
 *  - Toutes les transitions DB utilisent `updateMany WHERE status IN (...)`
 *    → 0 row si déjà transitionné = no-op silencieux (pas d'erreur).
 *  - Le matching N'EST PAS rejoué si la mission est déjà en `PUBLISHED` /
 *    autre état (lock SQL côté `transitionPendingPaymentToPublished`).
 */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type Stripe from 'stripe'

import type { Env } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { MissionsRepository } from '../../missions/missions.repository'
import { MatchingService } from '../../missions/services/matching.service'
import { MissionEventService } from '../../missions/services/mission-event.service'
import { PaymentsRepository } from '../payments.repository'

/** Types Stripe gérés en 3.2 — toute extension passe par un nouveau ticket. */
export const PAYMENT_DOMAIN_EVENT_TYPES = new Set<string>([
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
])

/**
 * Erreur défense-en-profondeur Ticket 3.2 (ajustement CTO #3) — l'event
 * Stripe re-fetché côté processor doit toujours matcher l'env d'exécution
 * (`event.livemode === (APP_ENV === 'production')`). L'ingestion HTTP a
 * déjà filtré, mais on re-vérifie au handler pour parer toute injection
 * directe en DB (rejeu admin, bug processor, etc.).
 */
export class PaymentDomainLivemodeMismatchError extends Error {
  constructor(
    readonly stripeEventId: string,
    readonly eventLivemode: boolean,
    readonly appEnvIsProduction: boolean,
  ) {
    super(
      `Stripe event ${stripeEventId} livemode=${eventLivemode} ` +
        `mismatches APP_ENV production=${appEnvIsProduction}`,
    )
    this.name = 'PaymentDomainLivemodeMismatchError'
  }
}

/**
 * Cancellation reasons Stripe → mapping `failureCode` côté Payment.
 *
 * Source : https://stripe.com/docs/api/payment_intents/object#payment_intent_object-cancellation_reason
 *
 * Cas `'automatic'` = autorisation expirée (~7 j sans capture) — rev2 state
 * machines, déclencheur futur du flow `authorization_expired` côté Ticket 3.4.
 */
const CANCELLATION_REASON_TO_FAILURE_CODE: Record<string, string> = {
  automatic: 'authorization_expired',
  requested_by_customer: 'requested_by_customer',
  abandoned: 'abandoned',
  duplicate: 'duplicate',
  fraudulent: 'fraudulent',
  failed_invoice: 'failed_invoice',
  void_invoice: 'void_invoice',
}

@Injectable()
export class PaymentDomainHandler {
  private readonly logger = new Logger(PaymentDomainHandler.name)
  private readonly listingTtlMs: number
  private readonly appEnvIsProduction: boolean

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsRepository,
    private readonly missions: MissionsRepository,
    private readonly missionEvents: MissionEventService,
    private readonly matching: MatchingService,
    config: ConfigService<Env, true>,
  ) {
    this.listingTtlMs = config.get('MISSION_LISTING_TTL_MS', { infer: true })
    this.appEnvIsProduction = config.get('APP_ENV', { infer: true }) === 'production'
  }

  /** Indique si cet event doit être routé (vs marqué PROCESSED sans action). */
  shouldHandle(type: string): boolean {
    return PAYMENT_DOMAIN_EVENT_TYPES.has(type)
  }

  /**
   * Point d'entrée — appelé par `StripeWebhookProcessor` après lock et
   * `stripe.events.retrieve()`. Toute exception relance le retry BullMQ
   * (jusqu'à 5 tentatives avant DLQ — cf. `payments.constants.ts`).
   *
   * Ticket 3.2 ajustement CTO #3 (Verify V11) : on revérifie ici la
   * cohérence `event.livemode` ↔ `APP_ENV` (défense en profondeur — le
   * filtre ingestion existe déjà côté `PaymentsWebhookService`, mais la
   * couche domain doit rester safe en cas de rejeu DB direct).
   */
  async handle(event: Stripe.Event): Promise<void> {
    this.assertEnvConsistency(event)
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated':
        await this.onAuthorized(event.data.object as Stripe.PaymentIntent)
        return
      case 'payment_intent.payment_failed':
        await this.onFailed(event.data.object as Stripe.PaymentIntent)
        return
      case 'payment_intent.canceled':
        await this.onCanceled(event.data.object as Stripe.PaymentIntent)
        return
      default:
        // Should-never-happen : le caller filtre via `shouldHandle()`.
        this.logger.warn({ type: event.type }, 'payments.domain.unknown_event_type')
    }
  }

  /**
   * Vérifie `event.livemode === (APP_ENV==='production')`. Lève une
   * `PaymentDomainLivemodeMismatchError` sinon (loguée + caught par
   * processor → marquée FAILED, pas retry — c'est un bug structurel).
   */
  private assertEnvConsistency(event: Stripe.Event): void {
    if (event.livemode !== this.appEnvIsProduction) {
      this.logger.error(
        {
          stripeEventId: event.id,
          eventLivemode: event.livemode,
          appEnvIsProduction: this.appEnvIsProduction,
        },
        'payments.domain.livemode_mismatch',
      )
      throw new PaymentDomainLivemodeMismatchError(
        event.id,
        event.livemode,
        this.appEnvIsProduction,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // amount_capturable_updated → AUTHORIZED + Mission PUBLISHED
  // ---------------------------------------------------------------------------

  private async onAuthorized(intent: Stripe.PaymentIntent): Promise<void> {
    const payment = await this.payments.findByStripePaymentIntentId(intent.id)
    if (!payment) {
      this.logger.warn(
        { intentId: intent.id },
        'payments.domain.authorized.payment_not_found',
      )
      return
    }

    // Si déjà AUTHORIZED (replay webhook), no-op silencieux.
    if (payment.status !== 'AUTHORIZATION_PENDING') {
      this.logger.log(
        { paymentId: payment.id, status: payment.status },
        'payments.domain.authorized.idempotent_skip',
      )
      return
    }

    const publishedAt = new Date()
    const listingExpiresAt = new Date(publishedAt.getTime() + this.listingTtlMs)
    let publishedNow = false

    await this.prisma.$transaction(async (tx) => {
      const updated = await this.payments.transitionPendingToAuthorizedTx(tx, {
        paymentId: payment.id,
      })
      if (updated !== 1) {
        // Race : un autre worker a déjà traité l'event (impossible normalement
        // car lock applicatif côté processor, mais ceinture+bretelles).
        return
      }
      const transitioned = await this.missions.transitionPendingPaymentToPublishedTx(tx, {
        missionId: payment.missionId,
        publishedAt,
        listingExpiresAt,
      })
      if (transitioned === 1) {
        publishedNow = true
        await this.missionEvents.recordTx(tx, {
          missionId: payment.missionId,
          type: 'PAYMENT_AUTHORIZED',
          actorUserId: null,
          payload: {
            paymentId: payment.id,
            stripePaymentIntentId: intent.id,
            amountCents: intent.amount,
          },
        })
        await this.missionEvents.recordTx(tx, {
          missionId: payment.missionId,
          type: 'PUBLISHED',
          actorUserId: null,
          payload: { listingTtlMs: this.listingTtlMs, source: 'payment_webhook' },
        })
      }
    })

    if (!publishedNow) {
      // Mission peut avoir été annulée pendant le délai webhook (rare). On a
      // tout de même autorisé le Payment — un refund sera émis Ticket 3.5.
      this.logger.warn(
        { paymentId: payment.id, missionId: payment.missionId },
        'payments.domain.authorized.mission_not_pending_payment',
      )
      return
    }

    // Matching hors transaction (sa propre `$transaction`) — cohérent avec
    // `MissionsService.publish` (PRD-002). Échec matching = mission reste
    // PUBLISHED, retry batch possible (debt-matching-async-queue déjà ouverte).
    try {
      await this.matching.runFor(payment.missionId)
    } catch (err) {
      this.logger.error(
        {
          missionId: payment.missionId,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'payments.domain.authorized.matching_failed',
      )
      // Pas de re-throw : on ne veut pas que le webhook retry à cause du
      // matching (la mission est déjà publiée). Le retry batch matching
      // gère la reprise.
    }

    this.logger.log(
      {
        paymentId: payment.id,
        missionId: payment.missionId,
        intentId: intent.id,
      },
      'payments.domain.authorized.published',
    )
  }

  // ---------------------------------------------------------------------------
  // payment_failed → Payment FAILED (mission reste PENDING_PAYMENT)
  // ---------------------------------------------------------------------------

  private async onFailed(intent: Stripe.PaymentIntent): Promise<void> {
    const payment = await this.payments.findByStripePaymentIntentId(intent.id)
    if (!payment) {
      this.logger.warn({ intentId: intent.id }, 'payments.domain.failed.payment_not_found')
      return
    }

    const failureCode = intent.last_payment_error?.code ?? null
    const failureMessage = intent.last_payment_error?.message?.slice(0, 2_000) ?? null

    await this.prisma.$transaction(async (tx) => {
      const updated = await this.payments.markFailedTx(tx, {
        paymentId: payment.id,
        failureCode,
        failureMessage,
      })
      if (updated === 1) {
        await this.missionEvents.recordTx(tx, {
          missionId: payment.missionId,
          type: 'PAYMENT_FAILED',
          actorUserId: null,
          payload: {
            paymentId: payment.id,
            stripePaymentIntentId: intent.id,
            failureCode,
            // Pas de failureMessage en audit (peut contenir info carte Stripe brute).
          },
        })
      }
    })

    this.logger.log(
      { paymentId: payment.id, intentId: intent.id, failureCode },
      'payments.domain.failed.processed',
    )
  }

  // ---------------------------------------------------------------------------
  // canceled → Payment CANCELLED + Mission CANCELLED (avec auth_expired flag)
  // ---------------------------------------------------------------------------

  private async onCanceled(intent: Stripe.PaymentIntent): Promise<void> {
    const payment = await this.payments.findByStripePaymentIntentId(intent.id)
    if (!payment) {
      this.logger.warn({ intentId: intent.id }, 'payments.domain.canceled.payment_not_found')
      return
    }

    const stripeReason = intent.cancellation_reason ?? null
    const failureCode = stripeReason ? CANCELLATION_REASON_TO_FAILURE_CODE[stripeReason] ?? stripeReason : null

    await this.prisma.$transaction(async (tx) => {
      const updated = await this.payments.markCancelledTx(tx, {
        paymentId: payment.id,
        failureCode,
        failureMessage: stripeReason,
      })
      if (updated === 1) {
        await this.missions.transitionPendingPaymentToCancelledTx(tx, {
          missionId: payment.missionId,
        })
        await this.missionEvents.recordTx(tx, {
          missionId: payment.missionId,
          type: 'PAYMENT_CANCELLED',
          actorUserId: null,
          payload: {
            paymentId: payment.id,
            stripePaymentIntentId: intent.id,
            failureCode,
            isAuthorizationExpired: failureCode === 'authorization_expired',
          },
        })
      }
    })

    this.logger.log(
      {
        paymentId: payment.id,
        intentId: intent.id,
        failureCode,
        isAuthorizationExpired: failureCode === 'authorization_expired',
      },
      'payments.domain.canceled.processed',
    )
  }
}
