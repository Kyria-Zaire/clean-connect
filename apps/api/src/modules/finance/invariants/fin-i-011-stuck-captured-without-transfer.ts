/**
 * `FIN-I-011` — `Payment.CAPTURED ∧ pas de Transfer terminal > 24 h`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5 + OQ-15 (24 h ferme).
 *
 * Détection : un Payment est capturé depuis plus de 24 h mais aucun Transfer
 * n'est en {PENDING, SENT, FAILED}. Le séquestre est bloqué côté plateforme.
 *
 * Sévérité : **P1** (OQ-15 ferme — pas de P2 12 h).
 *
 * Cas particulier : Mission en DISPUTE_OPEN ⇒ ignorer (séquestre volontairement bloqué).
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES, FINANCE_THRESHOLDS } from '../finance.constants'

import type { InvariantBreak, InvariantClock, StuckInvariant, StuckInvariantInput } from './invariant.contract'

const AGE_MS = FINANCE_THRESHOLDS.capturedWithoutTransferHours * 60 * 60_000
const defaultClock: InvariantClock = { now: () => new Date() }

export const FIN_I_011: StuckInvariant = {
  code: FINANCE_INVARIANT_CODES.STUCK_CAPTURED_WITHOUT_TRANSFER,
  scope: 'stuck',
  description: 'Payment.CAPTURED sans Transfer terminal depuis plus de 24 h.',
  defaultSeverity: 'P1',

  apply(input: StuckInvariantInput, clock?: InvariantClock): InvariantBreak | null {
    if (input.kind !== 'PAYMENT') return null
    const { payment, transfer, missionStatus } = input
    if (payment.status !== 'CAPTURED') return null
    if (missionStatus === 'DISPUTE_OPEN') return null
    if (transfer) {
      const terminalOrPending: readonly string[] = ['PENDING', 'SENT', 'FAILED', 'RETRY_SCHEDULED']
      if (terminalOrPending.includes(transfer.status)) return null
    }

    const ageMs = (clock ?? defaultClock).now().getTime() - payment.updatedAt.getTime()
    if (ageMs < AGE_MS) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.STUCK_CAPTURED_WITHOUT_TRANSFER,
      mismatchType: 'STUCK_CAPTURED',
      resourceKind: 'PAYMENT',
      resourceId: payment.id,
      severity: 'P1',
      explanation:
        `Payment.CAPTURED depuis ${(ageMs / 3_600_000).toFixed(1)} h sans aucun Transfer (séquestre bloqué).`,
      remediationHint:
        'Vérifier le job d\'auto-release T+48h ouvrées (BullMQ delayed `escrow-auto-release`). ' +
        'Vérifier l\'éligibilité prestataire (`providerPayoutStatus=READY`). Si tout est OK, ' +
        'lancer un retry manuel de transfer (TODO debt admin endpoint).',
      dbSnapshot: sanitizeForFinanceSnapshot('PAYMENT', payment),
      stripeSnapshot: null,
    }
  },
}
