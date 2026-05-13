/**
 * `FIN-I-006` — `Stripe.PaymentIntent.amount_received = DB.Payment.amountCapturedCents`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : croisement externe — la valeur Stripe (source de vérité externe)
 * doit correspondre au montant capturé enregistré côté DB.
 *
 * Sévérité : P1 — divergence financière.
 *
 * Cas particuliers :
 *  - Stripe PI absent (`paymentIntent === null`) ⇒ MISSING_STRIPE (autre invariant).
 *  - DB.Payment.status != CAPTURED ⇒ ne s'applique pas.
 */

import { sanitizeForFinanceSnapshot, truncateStripeId } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_006: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.STRIPE_PI_AMOUNT_MATCHES_DB,
  scope: 'reconcile',
  description: 'Stripe PI.amount_received == DB Payment.amountCapturedCents quand CAPTURED.',
  defaultSeverity: 'P1',

  apply({ payment, stripe }: PaymentInvariantInput): InvariantBreak | null {
    if (payment.status !== 'CAPTURED') return null
    const pi = stripe.paymentIntent
    if (!pi) return null
    const stripeAmount = pi.amount_received ?? 0
    const dbAmount = payment.amountCapturedCents ?? 0
    if (stripeAmount === dbAmount) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.STRIPE_PI_AMOUNT_MATCHES_DB,
      mismatchType: 'AMOUNT',
      resourceKind: 'PAYMENT',
      resourceId: payment.id,
      severity: 'P1',
      explanation:
        `Stripe.PI.amount_received=${stripeAmount} != DB.amountCapturedCents=${dbAmount}.`,
      remediationHint:
        'Vérifier les webhooks `payment_intent.succeeded` et `payment_intent.amount_capturable_updated`. ' +
        'Si Stripe a la valeur de vérité, appliquer la correction DB MANUELLEMENT (pas d\'auto-fix MVP).',
      amountDeltaCents: dbAmount - stripeAmount,
      dbSnapshot: sanitizeForFinanceSnapshot('PAYMENT', payment),
      stripeSnapshot: sanitizeForFinanceSnapshot('PAYMENT', {
        id: pi.id,
        status: pi.status,
        amountAuthorizedCents: pi.amount,
        amountCapturedCents: pi.amount_received,
        currency: pi.currency,
        applicationFeeCents: pi.application_fee_amount ?? null,
        stripePaymentIntentIdTruncated: truncateStripeId(pi.id) ?? undefined,
      }),
    }
  },
}
