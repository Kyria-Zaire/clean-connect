/**
 * `FIN-I-001` — `Payment.status = CAPTURED ⇒ amountCapturedCents > 0`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : un Payment marqué CAPTURED dont le montant capturé est nul ou
 * absent indique une corruption d'état (typiquement un webhook
 * `payment_intent.succeeded` reçu sans montant ou une mutation manuelle DB).
 *
 * Sévérité : P1 — bloque l'auto-release downstream.
 * Pas de correction automatique : seul un admin peut décider d'invalider le
 * Payment ou de réinjecter le montant via `POST /v1/admin/payments/:id/import-from-stripe`
 * (TODO debt Ticket 4.3).
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_001: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.CAPTURED_REQUIRES_AMOUNT,
  scope: 'reconcile',
  description: 'Payment.CAPTURED implique amountCapturedCents > 0.',
  defaultSeverity: 'P1',

  apply({ payment }: PaymentInvariantInput): InvariantBreak | null {
    if (payment.status !== 'CAPTURED') return null
    const captured = payment.amountCapturedCents ?? 0
    if (captured > 0) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.CAPTURED_REQUIRES_AMOUNT,
      mismatchType: 'STATUS',
      resourceKind: 'PAYMENT',
      resourceId: payment.id,
      severity: 'P1',
      explanation:
        'Le Payment est marqué CAPTURED mais amountCapturedCents est nul ou absent. ' +
        'Soit le webhook payment_intent.succeeded a été reçu sans amount_received, ' +
        'soit la table Payment a été mutée manuellement.',
      remediationHint:
        'Vérifier Stripe.PaymentIntent.amount_received via /admin/payments/:id, comparer ' +
        'avec la DB et corriger manuellement (pas de fix automatique au MVP). ' +
        'Si Stripe confirme amount_received > 0, ouvrir un ticket data-fix.',
      amountDeltaCents: captured,
      dbSnapshot: sanitizeForFinanceSnapshot('PAYMENT', payment),
      stripeSnapshot: null,
    }
  },
}
