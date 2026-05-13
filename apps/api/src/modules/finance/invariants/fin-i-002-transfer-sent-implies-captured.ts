/**
 * `FIN-I-002` — `Transfer.status = SENT ⇒ Payment.status = CAPTURED`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : un Transfer marqué SENT alors que son Payment associé n'est pas
 * encore CAPTURED indique une rupture de séquence métier (le séquestre a été
 * libéré sans capture). Cas potentiel : webhook `transfer.created` traité avant
 * `payment_intent.succeeded`, ou désynchronisation manuelle.
 *
 * Sévérité : P1 — implique une perte financière potentielle (fonds envoyés au
 * prestataire sans avoir été capturés côté client).
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_002: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.TRANSFER_SENT_IMPLIES_CAPTURED,
  scope: 'reconcile',
  description: 'Transfer.SENT implique Payment.CAPTURED.',
  defaultSeverity: 'P1',

  apply({ payment, transfer }: PaymentInvariantInput): InvariantBreak | null {
    if (!transfer || transfer.status !== 'SENT') return null
    if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.TRANSFER_SENT_IMPLIES_CAPTURED,
      mismatchType: 'STATUS',
      resourceKind: 'TRANSFER',
      resourceId: transfer.id,
      severity: 'P1',
      explanation: `Transfer.SENT pour Payment.id=${payment.id} dont status=${payment.status} (attendu CAPTURED).`,
      remediationHint:
        'Vérifier l\'ordre des webhooks Stripe (payment_intent.succeeded vs transfer.created). ' +
        'Si Stripe confirme la capture, corriger le Payment.status manuellement et ouvrir ticket. ' +
        'Sinon, c\'est une violation séquestre qui doit déclencher un litige interne.',
      dbSnapshot: sanitizeForFinanceSnapshot('TRANSFER', transfer),
      stripeSnapshot: null,
    }
  },
}
