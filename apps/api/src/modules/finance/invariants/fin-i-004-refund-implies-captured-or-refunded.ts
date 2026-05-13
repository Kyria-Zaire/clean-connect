/**
 * `FIN-I-004` — `Refund.status = REFUNDED ⇒ Payment.status ∈ {CAPTURED, REFUNDED}`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : un Refund REFUNDED dont le Payment associé n'est pas en état
 * CAPTURED ou REFUNDED indique une rupture séquence (refund avant capture =
 * impossible logiquement côté Stripe, donc nécessairement dérive DB).
 *
 * Sévérité : P1.
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

const ALLOWED_PAYMENT_STATUSES = new Set(['CAPTURED', 'REFUNDED', 'REFUND_PENDING'])

export const FIN_I_004: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.REFUND_IMPLIES_CAPTURED_OR_REFUNDED,
  scope: 'reconcile',
  description: 'Refund.REFUNDED implique Payment ∈ {CAPTURED, REFUND_PENDING, REFUNDED}.',
  defaultSeverity: 'P1',

  apply({ payment, refunds }: PaymentInvariantInput): InvariantBreak | null {
    const refunded = refunds.find((r) => r.status === 'REFUNDED')
    if (!refunded) return null
    if (ALLOWED_PAYMENT_STATUSES.has(payment.status)) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.REFUND_IMPLIES_CAPTURED_OR_REFUNDED,
      mismatchType: 'STATUS',
      resourceKind: 'REFUND',
      resourceId: refunded.id,
      severity: 'P1',
      explanation:
        `Refund.REFUNDED (id=${refunded.id}) sur Payment.status=${payment.status} (attendu CAPTURED|REFUND_PENDING|REFUNDED).`,
      remediationHint:
        'Vérifier la chronologie webhooks Stripe (`charge.refunded` vs `payment_intent.succeeded`). ' +
        'Si Stripe confirme la capture, corriger Payment.status manuellement.',
      dbSnapshot: sanitizeForFinanceSnapshot('REFUND', refunded),
      stripeSnapshot: null,
    }
  },
}
