/**
 * PRD-003 Ticket 3.1 — Ingestion webhooks Stripe.
 *
 * Pipeline (séquence stricte — rule stripe + securite) :
 *  1. Reject early si `FF_PAYMENTS_ENABLED=false`            (503)
 *  2. Vérification HMAC via `stripe.webhooks.constructEvent` (400 si KO)
 *  3. `assertEnvConsistency` : livemode ↔ APP_ENV             (400 si KO)
 *  4. `payloadHash = sha256(rawBody)` (anti-tampering)
 *  5. INSERT `StripeWebhookEvent` (PK = `stripeEventId`)
 *     - P2002 → 202 idempotent (clarification Build vs OpenAPI doc, voir PRD-003 §5.4)
 *  6. Enqueue BullMQ `STRIPE_WEBHOOK_QUEUE` (jobId déterministe)
 *  7. Retour 202 (handler controller)
 *
 * Hors-scope Ticket 3.1 :
 * - Le routing métier (PaymentIntent / Transfer / Refund / Account) sera ajouté
 *   par les Tickets 3.2 → 3.5. En 3.1 le processor marque simplement `PROCESSED`.
 */

import { createHash } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Queue } from 'bullmq'
import type Stripe from 'stripe'

import { loadEnv, type Env } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import {
  STRIPE_WEBHOOK_BACKOFF_BASE_MS,
  STRIPE_WEBHOOK_MAX_ATTEMPTS,
  STRIPE_WEBHOOK_PROCESS_JOB,
  STRIPE_WEBHOOK_QUEUE,
} from '../payments.constants'
import {
  PaymentsDisabledException,
  WebhookInvalidSignatureException,
  WebhookLivemodeMismatchException,
  WebhookPayloadMalformedException,
} from '../payments.errors'
import { StripeClientFactory } from '../stripe/stripe.client'

/** Payload BullMQ — minimaliste (pas de raw payload dans Redis, audit V1). */
export interface StripeWebhookJobPayload {
  stripeEventId: string
  type: string
  livemode: boolean
  payloadHash: string
}

/** Résultat de l'ingestion (consommé par le controller pour shape réponse). */
export interface IngestResult {
  accepted: true
  idempotent: boolean
  eventId: string
}

const PRISMA_UNIQUE_VIOLATION = 'P2002'

@Injectable()
export class PaymentsWebhookService {
  private readonly logger = new Logger(PaymentsWebhookService.name)
  private readonly stripe: Stripe
  private readonly env: Env

  constructor(
    private readonly prisma: PrismaService,
    stripeFactory: StripeClientFactory,
    @InjectQueue(STRIPE_WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<StripeWebhookJobPayload>,
  ) {
    this.env = loadEnv()
    this.stripe = stripeFactory.build()
  }

  /**
   * Vérifie le flag avant tout traitement. Appelé depuis le controller —
   * factorisé pour pouvoir être utilisé par d'autres endpoints Payments futurs.
   */
  assertEnabled(): void {
    if (!this.env.FF_PAYMENTS_ENABLED) {
      throw new PaymentsDisabledException()
    }
  }

  /**
   * Pipeline complet d'ingestion. Le controller appelle ce point unique pour
   * éviter toute désérialisation prématurée du body brut.
   */
  async ingest(rawBody: Buffer, signatureHeader: string | undefined): Promise<IngestResult> {
    this.assertEnabled()

    if (!signatureHeader) {
      throw new WebhookInvalidSignatureException('missing_signature_header')
    }

    // 1. Signature HMAC AVANT toute désérialisation (rule stripe + securite)
    let event: Stripe.Event
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        this.env.STRIPE_WEBHOOK_SECRET,
        this.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      )
    } catch (err) {
      // On NE log PAS le contenu du raw body (peut contenir PII/cards potentiellement
      // si malveillant) — uniquement la raison Stripe (`Stripe.errors.StripeSignatureVerificationError`).
      this.logger.warn(
        {
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'stripe.webhook.signature.invalid',
      )
      throw new WebhookInvalidSignatureException()
    }

    // 2. Validation forme minimale (Niveau 1 cf. webhook.ts) — événements hors
    // catalogue 3.1 sont stockés en DB pour observabilité mais marqués PROCESSED
    // sans routing (les tickets 3.2+ étendront le mapping).
    if (typeof event.id !== 'string' || !event.id.startsWith('evt_')) {
      throw new WebhookPayloadMalformedException('stripe_event_id_invalid')
    }

    // 3. Cohérence env ↔ livemode (audit Verify V8 + rule securite)
    this.assertEnvConsistency(event)

    // 4. Hash payload (anti-tampering Redis + traçabilité audit)
    const payloadHash = createHash('sha256').update(rawBody).digest('hex')

    // 5. Insert idempotent (PK = stripeEventId) — replay → 202 idempotent
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payloadHash,
          livemode: event.livemode,
          processingStatus: 'PENDING',
        },
      })
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.log(
          { eventId: event.id, type: event.type, livemode: event.livemode },
          'stripe.webhook.replay.idempotent',
        )
        return { accepted: true, idempotent: true, eventId: event.id }
      }
      throw err
    }

    // 6. Enqueue traitement asynchrone — jobId déterministe = anti-doublons côté BullMQ
    await this.webhookQueue.add(
      STRIPE_WEBHOOK_PROCESS_JOB,
      {
        stripeEventId: event.id,
        type: event.type,
        livemode: event.livemode,
        payloadHash,
      },
      {
        jobId: `stripe-webhook-${event.id}`,
        attempts: STRIPE_WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: STRIPE_WEBHOOK_BACKOFF_BASE_MS },
        removeOnComplete: { count: 1_000 },
        // Garder les échecs en Redis pour debug pendant les premières
        // semaines après mise en prod. Le purge final passe par DLQ DB.
        removeOnFail: false,
      },
    )

    this.logger.log(
      { eventId: event.id, type: event.type, livemode: event.livemode },
      'stripe.webhook.ingested',
    )

    return { accepted: true, idempotent: false, eventId: event.id }
  }

  /**
   * Refus dur si `event.livemode` (sk_live_*) arrive sur un env non-production
   * (ou inverse). Empêche un webhook test de corrompre la DB prod et vice-versa.
   *
   * Règle stricte : `event.livemode === (APP_ENV === 'production')`.
   */
  private assertEnvConsistency(event: Stripe.Event): void {
    const isProdEnv = this.env.APP_ENV === 'production'
    if (event.livemode !== isProdEnv) {
      const reason = `event.livemode=${event.livemode} mismatches APP_ENV=${this.env.APP_ENV}`
      this.logger.warn({ eventId: event.id, eventType: event.type }, `stripe.webhook.${reason}`)
      throw new WebhookLivemodeMismatchException(reason)
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_VIOLATION
    )
  }

  /**
   * PRD-003 Ticket 3.5 — liste DLQ Stripe (observabilité admin).
   */
  async listStripeDeadLetters(opts: { limit: number; resolved: boolean }): Promise<
    {
      id: string
      externalEventId: string
      payloadHash: string | null
      errorMessage: string
      attempts: number
      lastAttemptAt: Date
      resolvedAt: Date | null
      createdAt: Date
    }[]
  > {
    return this.prisma.webhookDeadLetter.findMany({
      where: {
        source: 'STRIPE',
        ...(opts.resolved ? { resolvedAt: { not: null } } : { resolvedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      select: {
        id: true,
        externalEventId: true,
        payloadHash: true,
        errorMessage: true,
        attempts: true,
        lastAttemptAt: true,
        resolvedAt: true,
        createdAt: true,
      },
    })
  }

  /**
   * PRD-003 Ticket 3.5 — replay admin-only : reset `StripeWebhookEvent` + re-enqueue BullMQ.
   * Idempotent / retry-safe : handlers métier restent idempotents sur replay.
   */
  async replayStripeDeadLetter(dlqId: string): Promise<void> {
    const row = await this.prisma.webhookDeadLetter.findUnique({ where: { id: dlqId } })
    if (!row || row.source !== 'STRIPE') {
      throw new NotFoundException({ error: 'WEBHOOK_DLQ_NOT_FOUND' })
    }
    const ev = await this.prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: row.externalEventId },
    })
    if (!ev) {
      throw new NotFoundException({ error: 'STRIPE_WEBHOOK_EVENT_NOT_FOUND' })
    }
    await this.prisma.stripeWebhookEvent.update({
      where: { stripeEventId: row.externalEventId },
      data: {
        processingStatus: 'PENDING',
        processingStartedAt: null,
        processedAt: null,
        lastError: null,
      },
    })
    await this.webhookQueue.add(
      STRIPE_WEBHOOK_PROCESS_JOB,
      {
        stripeEventId: row.externalEventId,
        type: ev.type,
        livemode: ev.livemode,
        payloadHash: row.payloadHash ?? ev.payloadHash,
      },
      {
        jobId: `stripe-webhook-replay-${row.id}-${Date.now()}`,
        attempts: STRIPE_WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: STRIPE_WEBHOOK_BACKOFF_BASE_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: false,
      },
    )
    this.logger.log({ dlqId, stripeEventId: row.externalEventId }, 'stripe.webhook.dlq.replay_enqueued')
  }
}
