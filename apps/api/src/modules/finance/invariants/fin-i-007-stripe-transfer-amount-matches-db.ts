/**
 * `FIN-I-007` — `Stripe.Transfer.amount = DB.Transfer.amountCents`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Sévérité : P1.
 */

import { sanitizeForFinanceSnapshot, truncateStripeId } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_007: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.STRIPE_TRANSFER_AMOUNT_MATCHES_DB,
  scope: 'reconcile',
  description: 'Stripe.Transfer.amount == DB.Transfer.amountCents quand SENT.',
  defaultSeverity: 'P1',

  apply({ transfer, stripe }: PaymentInvariantInput): InvariantBreak | null {
    if (!transfer || transfer.status !== 'SENT') return null
    const st = stripe.transfer
    if (!st) return null
    if (st.amount === transfer.amountCents) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.STRIPE_TRANSFER_AMOUNT_MATCHES_DB,
      mismatchType: 'AMOUNT',
      resourceKind: 'TRANSFER',
      resourceId: transfer.id,
      severity: 'P1',
      explanation: `Stripe.Transfer.amount=${st.amount} != DB.Transfer.amountCents=${transfer.amountCents}.`,
      remediationHint:
        'Geler le retry/réémission de ce Transfer. Comparer à `Payment.providerPayoutCents` (FIN-I-003). ' +
        'Investigation manuelle obligatoire — pas de correction automatique.',
      amountDeltaCents: transfer.amountCents - st.amount,
      dbSnapshot: sanitizeForFinanceSnapshot('TRANSFER', transfer),
      stripeSnapshot: sanitizeForFinanceSnapshot('TRANSFER', {
        id: st.id,
        status: 'SENT',
        amountCents: st.amount,
        currency: st.currency,
        stripeTransferIdTruncated: truncateStripeId(st.id) ?? undefined,
      }),
    }
  },
}
