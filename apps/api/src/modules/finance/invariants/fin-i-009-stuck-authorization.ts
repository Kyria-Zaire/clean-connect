/**
 * `FIN-I-009` — `Payment.AUTHORIZED ∧ createdAt < now - 5 j` ⇒ alerte préventive.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Visa/MC permettent typiquement 7 jours d'autorisation. Au-delà, l'auto-cancel
 * Stripe (`authorization_expired`) peut survenir et le Payment passe en CANCELLED.
 * On alerte préventivement à J-5 pour permettre une capture manuelle ou un
 * support client.
 *
 * Sévérité : P1 — pas de fix automatique : seul un humain peut décider de
 * capture vs cancel.
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES, FINANCE_THRESHOLDS } from '../finance.constants'

import type { InvariantBreak, InvariantClock, StuckInvariant, StuckInvariantInput } from './invariant.contract'

const AGE_MS = FINANCE_THRESHOLDS.authorizationAgeDays * 24 * 60 * 60_000
const defaultClock: InvariantClock = { now: () => new Date() }

export const FIN_I_009: StuckInvariant = {
  code: FINANCE_INVARIANT_CODES.STUCK_AUTHORIZATION,
  scope: 'stuck',
  description: 'Payment.AUTHORIZED depuis plus de 5 jours.',
  defaultSeverity: 'P1',

  apply(input: StuckInvariantInput, clock?: InvariantClock): InvariantBreak | null {
    if (input.kind !== 'PAYMENT') return null
    const { payment } = input
    if (payment.status !== 'AUTHORIZED') return null
    const ageMs = (clock ?? defaultClock).now().getTime() - payment.createdAt.getTime()
    if (ageMs < AGE_MS) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.STUCK_AUTHORIZATION,
      mismatchType: 'STUCK_AUTHORIZATION',
      resourceKind: 'PAYMENT',
      resourceId: payment.id,
      severity: 'P1',
      explanation:
        `Payment.AUTHORIZED âgé de ${Math.round(ageMs / 86_400_000)} j. Risque expiration auto Stripe ` +
        `(authorization_expired typiquement à J-7).`,
      remediationHint:
        'Investiguer pourquoi la mission n\'a pas atteint CAPTURED. Si la mission est légitime, ' +
        'capturer manuellement via /admin/payments/:id (TODO debt). Si caduque, annuler.',
      dbSnapshot: sanitizeForFinanceSnapshot('PAYMENT', payment),
      stripeSnapshot: null,
    }
  },
}
