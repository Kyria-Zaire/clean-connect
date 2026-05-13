/**
 * `FIN-I-008` — `Stripe.Refund.amount = DB.Refund.amountCents`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Sévérité : P1 — `finance_refund_mismatch{kind=AMOUNT}`.
 */

import { sanitizeForFinanceSnapshot, truncateStripeId } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_008: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB,
  scope: 'reconcile',
  description: 'Stripe.Refund.amount == DB.Refund.amountCents pour chaque Refund REFUNDED.',
  defaultSeverity: 'P1',

  apply({ refunds, stripe }: PaymentInvariantInput): InvariantBreak | null {
    for (const r of refunds) {
      if (r.status !== 'REFUNDED') continue
      if (!r.stripeRefundId) continue
      const sr = stripe.refunds.find((s) => s.id === r.stripeRefundId)
      if (!sr) continue
      if (sr.amount === r.amountCents) continue

      return {
        mismatchCode: FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB,
        mismatchType: 'AMOUNT',
        resourceKind: 'REFUND',
        resourceId: r.id,
        severity: 'P1',
        explanation: `Stripe.Refund.amount=${sr.amount} != DB.Refund.amountCents=${r.amountCents}.`,
        remediationHint:
          'Auditer le code de création du Refund. Si Stripe a la valeur de vérité, ouvrir un ticket data-fix manuel.',
        amountDeltaCents: r.amountCents - sr.amount,
        dbSnapshot: sanitizeForFinanceSnapshot('REFUND', r),
        stripeSnapshot: sanitizeForFinanceSnapshot('REFUND', {
          id: sr.id,
          status: sr.status ?? 'REFUNDED',
          amountCents: sr.amount,
          currency: sr.currency,
          stripeRefundIdTruncated: truncateStripeId(sr.id) ?? undefined,
        }),
      }
    }
    return null
  },
}
