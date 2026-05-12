/**
 * PRD-004 Ticket 4.2 — Tests unitaires "poison job" sur Stripe webhook.
 *
 * Périmètre :
 *  - Vérifie le path `onJobFailed` quand `attemptsMade >= MAX` :
 *    * insert `WebhookDeadLetter`
 *    * `dlqMetrics.recordEnqueued('stripe')` (déclenche `dlq_growth` P1)
 *    * `retryMetrics.recordExhausted({queue, jobType, reason})`
 *    * `alerting.emit({severity: 'P0', kind: 'bullmq_failed_jobs', ...})`
 *    * pas d'event ID Stripe complet dans le contexte de l'alerte
 *  - Vérifie qu'avant l'exhaustion, aucune écriture DLQ + aucune alerte.
 *
 * Le test n'instancie pas `StripeWebhookProcessor` via Nest — il appelle
 * directement la méthode `onJobFailed` après stubbing des dépendances.
 */

import type { Job } from 'bullmq'
import type Stripe from 'stripe'

import type { PrismaService } from '../../../common/prisma/prisma.service'
import type { AlertingService } from '../../observability/alerting/alerting.service'
import type { AlertPayload } from '../../observability/alerting/alerting.types'
import type { DlqMetricsTracker } from '../../observability/metrics/dlq-metrics.tracker'
import type { RetryMetricsTracker } from '../../observability/metrics/retry-metrics.tracker'
import type { StripeMetricsTracker } from '../../observability/metrics/stripe-metrics.tracker'
import type { WebhookMetricsTracker } from '../../observability/metrics/webhook-metrics.tracker'
import { STRIPE_WEBHOOK_MAX_ATTEMPTS } from '../payments.constants'

import type { PaymentDomainHandler } from './payment-domain.handler'
import type { StripeWebhookJobPayload } from './payments-webhook.service'
import type { RefundDomainHandler } from './refund-domain.handler'
import { StripeWebhookProcessor } from './stripe-webhook.processor'
import type { TransferDomainHandler } from './transfer-domain.handler'

interface Fixtures {
  processor: StripeWebhookProcessor
  dlqEnqueued: jest.Mock
  retryRecorded: jest.Mock
  alertEmitted: AlertPayload[]
  prismaDlqCreate: jest.Mock
}

function buildProcessor(): Fixtures {
  const prismaDlqCreate = jest.fn(async () => ({ id: 'dlq-uuid' }))
  const prisma = {
    webhookDeadLetter: { create: prismaDlqCreate },
  } as unknown as PrismaService
  const noopHandler = { shouldHandle: () => false, handle: jest.fn() } as unknown
  const stripeMetrics = {} as unknown as StripeMetricsTracker
  const webhookMetrics = {} as unknown as WebhookMetricsTracker
  const dlqEnqueued = jest.fn()
  const dlqMetrics = {
    recordEnqueued: dlqEnqueued,
    recordReplayed: jest.fn(),
    recordReplayFailed: jest.fn(),
  } as unknown as DlqMetricsTracker
  const retryRecorded = jest.fn()
  const retryMetrics = { recordExhausted: retryRecorded } as unknown as RetryMetricsTracker
  const alertEmitted: AlertPayload[] = []
  const alerting = {
    emit: jest.fn(async (p: AlertPayload) => {
      alertEmitted.push(p)
    }),
  } as unknown as AlertingService
  const stripe = {} as unknown as Stripe

  const processor = new StripeWebhookProcessor(
    prisma,
    noopHandler as PaymentDomainHandler,
    noopHandler as TransferDomainHandler,
    noopHandler as RefundDomainHandler,
    stripeMetrics,
    webhookMetrics,
    dlqMetrics,
    retryMetrics,
    alerting,
    stripe,
  )
  return { processor, dlqEnqueued, retryRecorded, alertEmitted, prismaDlqCreate }
}

function makeJob(opts: { attemptsMade: number; eventId: string; type: string }): Job<StripeWebhookJobPayload> {
  return {
    name: 'process',
    id: 'bull-job-id',
    data: {
      stripeEventId: opts.eventId,
      type: opts.type,
      livemode: false,
      payloadHash: 'h'.repeat(64),
    } as StripeWebhookJobPayload,
    attemptsMade: opts.attemptsMade,
  } as unknown as Job<StripeWebhookJobPayload>
}

describe('StripeWebhookProcessor onJobFailed — poison job (PRD-004 Ticket 4.2)', () => {
  it('does NOT write DLQ / metrics / alert before MAX attempts', async () => {
    const { processor, dlqEnqueued, retryRecorded, alertEmitted, prismaDlqCreate } = buildProcessor()
    const job = makeJob({
      attemptsMade: STRIPE_WEBHOOK_MAX_ATTEMPTS - 1,
      eventId: 'evt_abc123def456ghi789',
      type: 'payment_intent.succeeded',
    })
    await processor.onJobFailed(job, new Error('transient_fail'))
    expect(prismaDlqCreate).not.toHaveBeenCalled()
    expect(dlqEnqueued).not.toHaveBeenCalled()
    expect(retryRecorded).not.toHaveBeenCalled()
    expect(alertEmitted).toHaveLength(0)
  })

  it('writes DLQ + records metric + emits P0 alert at MAX attempts', async () => {
    const { processor, dlqEnqueued, retryRecorded, alertEmitted, prismaDlqCreate } = buildProcessor()
    const eventId = 'evt_abc123def456ghi789'
    const job = makeJob({
      attemptsMade: STRIPE_WEBHOOK_MAX_ATTEMPTS,
      eventId,
      type: 'payment_intent.succeeded',
    })
    await processor.onJobFailed(job, new Error('persistent_handler_bug'))

    expect(prismaDlqCreate).toHaveBeenCalledTimes(1)
    const dlqCall = prismaDlqCreate.mock.calls[0]![0] as { data: { externalEventId: string; attempts: number } }
    expect(dlqCall.data.externalEventId).toBe(eventId)
    expect(dlqCall.data.attempts).toBe(STRIPE_WEBHOOK_MAX_ATTEMPTS)

    expect(dlqEnqueued).toHaveBeenCalledWith('stripe')
    expect(retryRecorded).toHaveBeenCalledWith({
      queue: 'stripe-webhooks',
      jobType: 'stripe_webhook',
      reason: 'transient_max_attempts',
    })

    expect(alertEmitted).toHaveLength(1)
    const alert = alertEmitted[0]!
    expect(alert.severity).toBe('P0')
    expect(alert.kind).toBe('bullmq_failed_jobs')
    expect(alert.title).toContain('payment_intent.succeeded')
  })

  it('truncates event ID in alert context to 12 chars (no full evt_id leak)', async () => {
    const { processor, alertEmitted } = buildProcessor()
    const eventId = 'evt_super_long_secret_event_id_zzzzzzzzzzzzzzzzzzzz'
    const job = makeJob({
      attemptsMade: STRIPE_WEBHOOK_MAX_ATTEMPTS,
      eventId,
      type: 'transfer.created',
    })
    await processor.onJobFailed(job, new Error('boom'))
    const ctx = alertEmitted[0]!.context as Record<string, unknown>
    expect(ctx.eventIdShort).toBe('evt_super_lo')
    const ctxJson = JSON.stringify(ctx)
    expect(ctxJson).not.toContain('zzzzzzz')
    expect(ctxJson).not.toContain('super_long_secret')
  })

  it('does not throw if DLQ create fails (graceful — original error must surface elsewhere)', async () => {
    const { processor, prismaDlqCreate } = buildProcessor()
    prismaDlqCreate.mockRejectedValueOnce(new Error('db_down'))
    const job = makeJob({
      attemptsMade: STRIPE_WEBHOOK_MAX_ATTEMPTS,
      eventId: 'evt_xyz',
      type: 'charge.refunded',
    })
    await expect(processor.onJobFailed(job, new Error('boom'))).resolves.toBeUndefined()
  })

  it('is a no-op when job is undefined (BullMQ legacy event)', async () => {
    const { processor, dlqEnqueued, alertEmitted } = buildProcessor()
    await processor.onJobFailed(undefined, new Error('boom'))
    expect(dlqEnqueued).not.toHaveBeenCalled()
    expect(alertEmitted).toHaveLength(0)
  })
})
