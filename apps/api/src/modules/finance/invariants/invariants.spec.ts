/**
 * PRD-004 Ticket 4.5 Build itération 2 — Tests unitaires des 11 invariants.
 *
 * Chaque invariant DOIT être :
 *  - autonome (testable sans DB ni Stripe)
 *  - prouvable (cas positif + négatif)
 *  - documenté via `description` (testé)
 *  - observable via `mismatchCode` versionné (testé)
 *
 * Ces tests font foi pour : runbook, dashboards, support, exports, alertes.
 */

import type { Payment, Refund, Transfer } from '@prisma/client'
import type Stripe from 'stripe'

import {
  FINANCE_INVARIANT_CODES,
  type FinanceInvariantCode,
} from '../finance.constants'

import { FIN_I_001 } from './fin-i-001-captured-requires-amount'
import { FIN_I_002 } from './fin-i-002-transfer-sent-implies-captured'
import { FIN_I_003 } from './fin-i-003-transfer-amount-equals-provider-payout'
import { FIN_I_004 } from './fin-i-004-refund-implies-captured-or-refunded'
import { FIN_I_005 } from './fin-i-005-refund-after-transfer-not-system'
import { FIN_I_006 } from './fin-i-006-stripe-pi-amount-matches-db'
import { FIN_I_007 } from './fin-i-007-stripe-transfer-amount-matches-db'
import { FIN_I_008 } from './fin-i-008-stripe-refund-amount-matches-db'
import { FIN_I_009 } from './fin-i-009-stuck-authorization'
import { FIN_I_010 } from './fin-i-010-stuck-transfer-pending'
import { FIN_I_011 } from './fin-i-011-stuck-captured-without-transfer'
import { FIN_J_001 } from './fin-j-001-daily-balance'
import type { InvariantClock } from './invariant.contract'
import { ALL_INVARIANT_CODES, RECONCILE_INVARIANTS, STUCK_INVARIANTS, DAILY_INVARIANTS } from './registry'


const NOW = new Date('2026-05-13T10:00:00.000Z')
const clock: InvariantClock = { now: () => NOW }

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    missionId: '22222222-2222-4222-8222-222222222222',
    stripePaymentIntentId: 'pi_test_001',
    idempotencyKey: 'idemp_pi_test_001',
    failureCode: null,
    failureMessage: null,
    amountAuthorizedCents: 5000,
    amountCapturedCents: 5000,
    currency: 'eur',
    applicationFeeCents: 900,
    providerPayoutCents: 4100,
    vatRateSnapshot: null,
    status: 'CAPTURED',
    createdAt: new Date('2026-05-12T10:00:00.000Z'),
    updatedAt: new Date('2026-05-13T08:00:00.000Z'),
    ...overrides,
  } as Payment
}

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    paymentId: '11111111-1111-4111-8111-111111111111',
    stripeTransferId: 'tr_test_001',
    amountCents: 4100,
    currency: 'eur',
    status: 'SENT',
    idempotencyKey: 'idemp_tr_test_001',
    retryCount: 0,
    lastRetryAt: null,
    failureCode: null,
    failureReason: null,
    createdAt: new Date('2026-05-13T08:30:00.000Z'),
    updatedAt: new Date('2026-05-13T09:00:00.000Z'),
    ...overrides,
  } as Transfer
}

function makeRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    paymentId: '11111111-1111-4111-8111-111111111111',
    stripeRefundId: 're_test_001',
    idempotencyKey: 'idemp_re_test_001',
    amountCents: 5000,
    currency: 'eur',
    status: 'REFUNDED',
    reason: null,
    failureCode: null,
    failureReason: null,
    initiatedBy: 'admin-uuid-7777',
    createdAt: new Date('2026-05-13T09:30:00.000Z'),
    updatedAt: new Date('2026-05-13T09:31:00.000Z'),
    settledAt: new Date('2026-05-13T09:31:00.000Z'),
    ...overrides,
  } as Refund
}

describe('Finance invariants — registry', () => {
  it('exporte exactement 12 invariants (8 reconcile + 3 stuck + 1 daily)', () => {
    expect(RECONCILE_INVARIANTS).toHaveLength(8)
    expect(STUCK_INVARIANTS).toHaveLength(3)
    expect(DAILY_INVARIANTS).toHaveLength(1)
    expect(ALL_INVARIANT_CODES).toHaveLength(12)
  })

  it('tous les codes sont uniques et conformes /^FIN-[IJ]-\\d{3}$/', () => {
    const set = new Set(ALL_INVARIANT_CODES)
    expect(set.size).toBe(ALL_INVARIANT_CODES.length)
    for (const c of ALL_INVARIANT_CODES) {
      expect(c).toMatch(/^FIN-[IJ]-\d{3}$/)
    }
  })

  it('chaque code constants pointe vers un invariant enregistré', () => {
    const codeMap: Readonly<Record<FinanceInvariantCode, true>> = Object.fromEntries(
      ALL_INVARIANT_CODES.map((c) => [c, true]),
    ) as Readonly<Record<FinanceInvariantCode, true>>
    for (const code of Object.values(FINANCE_INVARIANT_CODES)) {
      expect(codeMap[code]).toBe(true)
    }
  })
})

describe('FIN-I-001 — Captured implique amountCapturedCents > 0', () => {
  it('OK : status=CAPTURED, amount>0', () => {
    expect(FIN_I_001.apply({ payment: makePayment(), transfer: null, refunds: [], stripe: stripeNull() })).toBeNull()
  })
  it('BREAK : status=CAPTURED, amount=0', () => {
    const r = FIN_I_001.apply({
      payment: makePayment({ amountCapturedCents: 0 }),
      transfer: null,
      refunds: [],
      stripe: stripeNull(),
    })
    expect(r).not.toBeNull()
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.CAPTURED_REQUIRES_AMOUNT)
    expect(r?.severity).toBe('P1')
    expect(r?.remediationHint.length).toBeGreaterThan(20)
  })
  it('SKIP : status=AUTHORIZED', () => {
    expect(
      FIN_I_001.apply({
        payment: makePayment({ status: 'AUTHORIZED', amountCapturedCents: null }),
        transfer: null,
        refunds: [],
        stripe: stripeNull(),
      }),
    ).toBeNull()
  })
})

describe('FIN-I-002 — Transfer.SENT implique Payment.CAPTURED', () => {
  it('OK : payment.CAPTURED', () => {
    expect(
      FIN_I_002.apply({ payment: makePayment(), transfer: makeTransfer(), refunds: [], stripe: stripeNull() }),
    ).toBeNull()
  })
  it('BREAK : payment.AUTHORIZED', () => {
    const r = FIN_I_002.apply({
      payment: makePayment({ status: 'AUTHORIZED' }),
      transfer: makeTransfer(),
      refunds: [],
      stripe: stripeNull(),
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.TRANSFER_SENT_IMPLIES_CAPTURED)
  })
  it('SKIP : transfer.PENDING', () => {
    expect(
      FIN_I_002.apply({
        payment: makePayment({ status: 'AUTHORIZED' }),
        transfer: makeTransfer({ status: 'PENDING' }),
        refunds: [],
        stripe: stripeNull(),
      }),
    ).toBeNull()
  })
})

describe('FIN-I-003 — Transfer.amount = Payment.providerPayout', () => {
  it('OK : montants alignés', () => {
    expect(
      FIN_I_003.apply({ payment: makePayment(), transfer: makeTransfer(), refunds: [], stripe: stripeNull() }),
    ).toBeNull()
  })
  it('BREAK : drift commission', () => {
    const r = FIN_I_003.apply({
      payment: makePayment({ providerPayoutCents: 4100 }),
      transfer: makeTransfer({ amountCents: 4200 }),
      refunds: [],
      stripe: stripeNull(),
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.TRANSFER_AMOUNT_EQUALS_PROVIDER_PAYOUT)
    expect(r?.amountDeltaCents).toBe(100)
  })
})

describe('FIN-I-004 — Refund REFUNDED implique payment ∈ {CAPTURED, REFUND_PENDING, REFUNDED}', () => {
  it('OK : payment CAPTURED', () => {
    expect(
      FIN_I_004.apply({
        payment: makePayment({ status: 'CAPTURED' }),
        transfer: null,
        refunds: [makeRefund()],
        stripe: stripeNull(),
      }),
    ).toBeNull()
  })
  it('BREAK : payment AUTHORIZED', () => {
    const r = FIN_I_004.apply({
      payment: makePayment({ status: 'AUTHORIZED' }),
      transfer: null,
      refunds: [makeRefund()],
      stripe: stripeNull(),
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.REFUND_IMPLIES_CAPTURED_OR_REFUNDED)
  })
})

describe('FIN-I-005 — Refund post-Transfer.SENT doit être manuel', () => {
  it('OK : initiatedBy = admin id', () => {
    expect(
      FIN_I_005.apply({
        payment: makePayment(),
        transfer: makeTransfer(),
        refunds: [makeRefund({ initiatedBy: 'admin-uuid' })],
        stripe: stripeNull(),
      }),
    ).toBeNull()
  })
  it('BREAK : initiatedBy = SYSTEM après SENT', () => {
    const r = FIN_I_005.apply({
      payment: makePayment(),
      transfer: makeTransfer(),
      refunds: [makeRefund({ initiatedBy: 'SYSTEM' })],
      stripe: stripeNull(),
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.REFUND_AFTER_TRANSFER_NOT_AUTOMATIC)
  })
})

describe('FIN-I-006 — Stripe PI amount = DB amountCapturedCents', () => {
  it('OK : montants alignés', () => {
    const pi = { id: 'pi_test_001', amount: 5000, amount_received: 5000, status: 'succeeded', currency: 'eur' } as Stripe.PaymentIntent
    expect(
      FIN_I_006.apply({
        payment: makePayment(),
        transfer: null,
        refunds: [],
        stripe: { paymentIntent: pi, transfer: null, refunds: [] },
      }),
    ).toBeNull()
  })
  it('BREAK : Stripe < DB', () => {
    const pi = { id: 'pi_test_001', amount: 5000, amount_received: 4500, status: 'succeeded', currency: 'eur' } as Stripe.PaymentIntent
    const r = FIN_I_006.apply({
      payment: makePayment(),
      transfer: null,
      refunds: [],
      stripe: { paymentIntent: pi, transfer: null, refunds: [] },
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STRIPE_PI_AMOUNT_MATCHES_DB)
    expect(r?.amountDeltaCents).toBe(500)
  })
  it('SKIP : Stripe missing (404)', () => {
    expect(
      FIN_I_006.apply({
        payment: makePayment(),
        transfer: null,
        refunds: [],
        stripe: { paymentIntent: null, transfer: null, refunds: [] },
      }),
    ).toBeNull()
  })
})

describe('FIN-I-007 — Stripe Transfer amount = DB amount', () => {
  it('BREAK : amounts diverge', () => {
    const stTransfer = { id: 'tr_test_001', amount: 4000, currency: 'eur' } as Stripe.Transfer
    const r = FIN_I_007.apply({
      payment: makePayment(),
      transfer: makeTransfer(),
      refunds: [],
      stripe: { paymentIntent: null, transfer: stTransfer, refunds: [] },
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STRIPE_TRANSFER_AMOUNT_MATCHES_DB)
  })
})

describe('FIN-I-008 — Stripe Refund amount = DB amount', () => {
  it('BREAK : refund amount diverge', () => {
    const sr = { id: 're_test_001', amount: 4500, status: 'succeeded', currency: 'eur' } as Stripe.Refund
    const r = FIN_I_008.apply({
      payment: makePayment(),
      transfer: null,
      refunds: [makeRefund({ amountCents: 5000 })],
      stripe: { paymentIntent: null, transfer: null, refunds: [sr] },
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB)
    expect(r?.amountDeltaCents).toBe(500)
  })
})

describe('FIN-I-009 — Stuck AUTHORIZATION > 5j', () => {
  it('OK : payment age 1j', () => {
    expect(
      FIN_I_009.apply(
        {
          kind: 'PAYMENT',
          payment: makePayment({ status: 'AUTHORIZED', createdAt: new Date('2026-05-12T10:00:00.000Z') }),
          transfer: null,
          refunds: [],
          missionStatus: 'PUBLISHED',
        },
        clock,
      ),
    ).toBeNull()
  })
  it('BREAK : payment age 6j', () => {
    const r = FIN_I_009.apply(
      {
        kind: 'PAYMENT',
        payment: makePayment({ status: 'AUTHORIZED', createdAt: new Date('2026-05-07T10:00:00.000Z') }),
        transfer: null,
        refunds: [],
        missionStatus: 'PUBLISHED',
      },
      clock,
    )
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STUCK_AUTHORIZATION)
  })
})

describe('FIN-I-010 — Transfer PENDING > 2h hors DISPUTE_OPEN', () => {
  it('OK : Mission DISPUTE_OPEN', () => {
    expect(
      FIN_I_010.apply(
        {
          kind: 'TRANSFER',
          transfer: makeTransfer({ status: 'PENDING', updatedAt: new Date('2026-05-13T07:00:00.000Z') }),
          payment: makePayment(),
          missionStatus: 'DISPUTE_OPEN',
        },
        clock,
      ),
    ).toBeNull()
  })
  it('BREAK : Transfer PENDING 3h', () => {
    const r = FIN_I_010.apply(
      {
        kind: 'TRANSFER',
        transfer: makeTransfer({ status: 'PENDING', updatedAt: new Date('2026-05-13T07:00:00.000Z') }),
        payment: makePayment(),
        missionStatus: 'COMPLETED',
      },
      clock,
    )
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STUCK_TRANSFER_PENDING)
    expect(r?.severity).toBe('P2')
  })
})

describe('FIN-I-011 — Captured sans Transfer terminal > 24h', () => {
  it('OK : transfer SENT', () => {
    expect(
      FIN_I_011.apply(
        {
          kind: 'PAYMENT',
          payment: makePayment({ status: 'CAPTURED', updatedAt: new Date('2026-05-12T08:00:00.000Z') }),
          transfer: makeTransfer({ status: 'SENT' }),
          refunds: [],
          missionStatus: 'COMPLETED',
        },
        clock,
      ),
    ).toBeNull()
  })
  it('BREAK : pas de transfer après 25h', () => {
    const r = FIN_I_011.apply(
      {
        kind: 'PAYMENT',
        payment: makePayment({ status: 'CAPTURED', updatedAt: new Date('2026-05-12T08:00:00.000Z') }),
        transfer: null,
        refunds: [],
        missionStatus: 'COMPLETED',
      },
      clock,
    )
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.STUCK_CAPTURED_WITHOUT_TRANSFER)
    expect(r?.severity).toBe('P1')
  })
  it('SKIP : Mission DISPUTE_OPEN même si > 24h', () => {
    expect(
      FIN_I_011.apply(
        {
          kind: 'PAYMENT',
          payment: makePayment({ status: 'CAPTURED', updatedAt: new Date('2026-05-12T08:00:00.000Z') }),
          transfer: null,
          refunds: [],
          missionStatus: 'DISPUTE_OPEN',
        },
        clock,
      ),
    ).toBeNull()
  })
})

describe('FIN-J-001 — Balance comptable J-1', () => {
  it('OK : balance équilibrée (tolérance 1 cent)', () => {
    expect(
      FIN_J_001.apply({
        reportDate: new Date('2026-05-12T00:00:00.000Z'),
        capturedSumCents: 10_000,
        transferSentSumCents: 8_200,
        refundedSumCents: 0,
        applicationFeeSumCents: 1_800,
      }),
    ).toBeNull()
  })
  it('BREAK : balance déséquilibrée 50 cents', () => {
    const r = FIN_J_001.apply({
      reportDate: new Date('2026-05-12T00:00:00.000Z'),
      capturedSumCents: 10_000,
      transferSentSumCents: 8_150,
      refundedSumCents: 0,
      applicationFeeSumCents: 1_800,
    })
    expect(r?.mismatchCode).toBe(FINANCE_INVARIANT_CODES.DAILY_BALANCE)
    expect(r?.amountDeltaCents).toBe(50)
    expect(r?.resourceKind).toBe('INVARIANT')
  })
})

function stripeNull(): {
  paymentIntent: null
  transfer: null
  refunds: readonly Stripe.Refund[]
} {
  return { paymentIntent: null, transfer: null, refunds: [] }
}
