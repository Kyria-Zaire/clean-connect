/**
 * `FIN-I-003` — `Transfer.amountCents = Payment.providerPayoutCents`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : la commission est snapshottée à la création du Payment
 * (`providerPayoutCents`) puis utilisée tel quel à la création du Transfer.
 * Toute divergence ici = drift commission (très critique : perte financière
 * silencieuse).
 *
 * Sévérité : P1 critique.
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_003: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.TRANSFER_AMOUNT_EQUALS_PROVIDER_PAYOUT,
  scope: 'reconcile',
  description: 'Transfer.amountCents == Payment.providerPayoutCents (lock-in commission).',
  defaultSeverity: 'P1',

  apply({ payment, transfer }: PaymentInvariantInput): InvariantBreak | null {
    if (!transfer) return null
    if (payment.providerPayoutCents === null || payment.providerPayoutCents === undefined) return null
    if (transfer.amountCents === payment.providerPayoutCents) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.TRANSFER_AMOUNT_EQUALS_PROVIDER_PAYOUT,
      mismatchType: 'AMOUNT',
      resourceKind: 'TRANSFER',
      resourceId: transfer.id,
      severity: 'P1',
      explanation:
        `Transfer.amountCents=${transfer.amountCents} != Payment.providerPayoutCents=${payment.providerPayoutCents}. ` +
        `Drift commission détecté.`,
      remediationHint:
        'Auditer le code de création Transfer (`stripe.transfers.create`) — la valeur DOIT venir de ' +
        '`Payment.providerPayoutCents`, pas d\'un recalcul runtime. Bloquer toute libération de ce Transfer ' +
        'jusqu\'à clarification comptable.',
      amountDeltaCents: transfer.amountCents - payment.providerPayoutCents,
      dbSnapshot: sanitizeForFinanceSnapshot('TRANSFER', transfer),
      stripeSnapshot: null,
    }
  },
}
