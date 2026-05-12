/**
 * PRD-003 Ticket 3.4 — tests unitaires `PaymentDomainHandler.onCaptured`.
 *
 * Couverture obligatoire (correction CTO Ticket 3.4) :
 *  1. Payment introuvable → no-op silencieux (audit warn).
 *  2. Payment déjà CAPTURED → no-op silencieux (replay webhook safe).
 *  3. Happy path → transition Payment AUTHORIZED→CAPTURED + Mission
 *     CLIENT_VALIDATION_PENDING→COMPLETED + cancel AutoReleaseJob
 *     + audits PAYMENT_CAPTURED + MISSION_COMPLETED.
 *  4. Race : la mission est déjà DISPUTE_OPEN (litige ouvert pendant délai
 *     webhook) → Payment passe CAPTURED, Mission reste DISPUTE_OPEN, pas
 *     d'audit MISSION_COMPLETED (le litige gère le state).
 *  5. AutoReleaseService.cancel échoue → on log mais on ne re-throw pas
 *     (la capture est déjà actée Stripe-side).
 */

import type { ConfigService } from '@nestjs/config'
import type { Mission, Payment, Prisma } from '@prisma/client'
import type Stripe from 'stripe'

import type { Env as EnvVars } from '../../../common/config/env'
import type { PrismaService } from '../../../common/prisma/prisma.service'
import type { MissionsRepository } from '../../missions/missions.repository'
import type { MatchingService } from '../../missions/services/matching.service'
import type { MissionEventService } from '../../missions/services/mission-event.service'
import type { AutoReleaseService } from '../../missions-completion/auto-release/auto-release.service'
import type { PaymentsRepository } from '../payments.repository'

import { PaymentDomainHandler } from './payment-domain.handler'

const PAYMENT_ID = '00000000-0000-4000-8000-000000000999'
const MISSION_ID = '00000000-0000-4000-8000-000000000001'
const PI_ID = 'pi_test_succeeded_001'

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    missionId: MISSION_ID,
    stripePaymentIntentId: PI_ID,
    idempotencyKey: 'cc-test-idempotency-key-1234',
    amountAuthorizedCents: 12_000,
    amountCapturedCents: null,
    currency: 'eur',
    applicationFeeCents: 2_160,
    providerPayoutCents: 9_840,
    vatRateSnapshot: null,
    status: 'AUTHORIZED',
    failureCode: null,
    failureMessage: null,
    createdAt: new Date('2026-05-20T08:00:00Z'),
    updatedAt: new Date('2026-05-20T08:00:00Z'),
    ...overrides,
  }
}

function buildIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: PI_ID,
    object: 'payment_intent',
    amount: 12_000,
    amount_received: 12_000,
    status: 'succeeded',
    livemode: false,
    ...overrides,
  } as Stripe.PaymentIntent
}

interface Harness {
  handler: PaymentDomainHandler
  payments: { findByStripePaymentIntentId: jest.Mock; transitionAuthorizedToCapturedTx: jest.Mock }
  missions: { transitionClientValidationPendingToCompletedTx: jest.Mock }
  events: { recordTx: jest.Mock }
  autoRelease: { cancel: jest.Mock }
}

function buildHarness(opts: {
  payment?: Payment | null
  captureResult?: number
  missionTransitionResult?: number
} = {}): Harness {
  const payments = {
    findByStripePaymentIntentId: jest
      .fn()
      .mockResolvedValue(opts.payment === undefined ? buildPayment() : opts.payment),
    transitionAuthorizedToCapturedTx: jest.fn().mockResolvedValue(opts.captureResult ?? 1),
  }
  const missions = {
    transitionClientValidationPendingToCompletedTx: jest
      .fn()
      .mockResolvedValue(opts.missionTransitionResult ?? 1),
  }
  const events = { recordTx: jest.fn().mockResolvedValue(undefined) }
  const autoRelease = { cancel: jest.fn().mockResolvedValue({ cancelled: true }) }
  const matching = { runFor: jest.fn() }

  const prismaTransaction = jest
    .fn()
    .mockImplementation(async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb({} as unknown as Prisma.TransactionClient),
    )
  const prisma = { $transaction: prismaTransaction } as unknown as PrismaService

  const config = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'MISSION_LISTING_TTL_MS') return 60_000
      if (key === 'APP_ENV') return 'development'
      return undefined
    }),
  } as unknown as ConfigService<EnvVars, true>

  const handler = new PaymentDomainHandler(
    prisma,
    payments as unknown as PaymentsRepository,
    missions as unknown as MissionsRepository,
    events as unknown as MissionEventService,
    matching as unknown as MatchingService,
    autoRelease as unknown as AutoReleaseService,
    config,
  )

  return { handler, payments, missions, events, autoRelease }
}

describe('PaymentDomainHandler.onCaptured (PRD-003 Ticket 3.4)', () => {
  it('payment introuvable → no-op silencieux', async () => {
    const { handler, missions } = buildHarness({ payment: null })
    await handler.handle({
      type: 'payment_intent.succeeded',
      data: { object: buildIntent() },
      id: 'evt_001',
      livemode: false,
    } as unknown as Stripe.Event)
    expect(missions.transitionClientValidationPendingToCompletedTx).not.toHaveBeenCalled()
  })

  it('payment déjà CAPTURED → replay webhook no-op silencieux', async () => {
    const { handler, payments, missions } = buildHarness({
      payment: buildPayment({ status: 'CAPTURED', amountCapturedCents: 12_000 }),
    })
    await handler.handle({
      type: 'payment_intent.succeeded',
      data: { object: buildIntent() },
      id: 'evt_002',
      livemode: false,
    } as unknown as Stripe.Event)
    expect(payments.transitionAuthorizedToCapturedTx).not.toHaveBeenCalled()
    expect(missions.transitionClientValidationPendingToCompletedTx).not.toHaveBeenCalled()
  })

  it('happy path → Payment CAPTURED + Mission COMPLETED + autoRelease.cancel + audits', async () => {
    const { handler, payments, missions, events, autoRelease } = buildHarness({})

    await handler.handle({
      type: 'payment_intent.succeeded',
      data: { object: buildIntent() },
      id: 'evt_003',
      livemode: false,
    } as unknown as Stripe.Event)

    expect(payments.transitionAuthorizedToCapturedTx).toHaveBeenCalledTimes(1)
    const captureArgs = payments.transitionAuthorizedToCapturedTx.mock.calls[0]?.[1] as {
      paymentId: string
      amountCapturedCents: number
    }
    expect(captureArgs.paymentId).toBe(PAYMENT_ID)
    expect(captureArgs.amountCapturedCents).toBe(12_000)

    expect(missions.transitionClientValidationPendingToCompletedTx).toHaveBeenCalledTimes(1)
    expect(autoRelease.cancel).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      reason: 'payment_captured',
    })

    const auditTypes = events.recordTx.mock.calls.map((c) => (c[1] as { type: string }).type)
    expect(auditTypes).toContain('PAYMENT_CAPTURED')
    expect(auditTypes).toContain('MISSION_COMPLETED')
  })

  it('race : mission en DISPUTE_OPEN → Payment capturé mais mission NON transitionnée', async () => {
    const { handler, payments, missions, events } = buildHarness({
      missionTransitionResult: 0,
    })

    await handler.handle({
      type: 'payment_intent.succeeded',
      data: { object: buildIntent() },
      id: 'evt_004',
      livemode: false,
    } as unknown as Stripe.Event)

    expect(payments.transitionAuthorizedToCapturedTx).toHaveBeenCalledTimes(1)
    expect(missions.transitionClientValidationPendingToCompletedTx).toHaveBeenCalledTimes(1)

    const auditTypes = events.recordTx.mock.calls.map((c) => (c[1] as { type: string }).type)
    expect(auditTypes).toContain('PAYMENT_CAPTURED')
    expect(auditTypes).not.toContain('MISSION_COMPLETED')
  })

  it('autoRelease.cancel échoue → on log mais on ne re-throw pas', async () => {
    const { handler, autoRelease, payments } = buildHarness({})
    autoRelease.cancel.mockRejectedValueOnce(new Error('Redis down'))

    await expect(
      handler.handle({
        type: 'payment_intent.succeeded',
        data: { object: buildIntent() },
        id: 'evt_005',
        livemode: false,
      } as unknown as Stripe.Event),
    ).resolves.toBeUndefined()

    expect(payments.transitionAuthorizedToCapturedTx).toHaveBeenCalledTimes(1)
  })
})

// Référence TS — empêche le lint "Mission imported but never used".
export type _DomainHandlerTypeRefs = Mission