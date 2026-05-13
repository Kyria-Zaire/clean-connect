/**
 * `FIN-I-010` — `Transfer.PENDING > 2 h ∧ Mission ≠ DISPUTE_OPEN`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Sévérité : P2 — `finance_transfer_pending` (cooldown 30 min batch).
 *
 * Cas particulier : si la Mission associée est en DISPUTE_OPEN, le séquestre
 * est volontairement bloqué — on ignore (cf. ADR-018 §2.8 cas A).
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES, FINANCE_THRESHOLDS } from '../finance.constants'

import type { InvariantBreak, InvariantClock, StuckInvariant, StuckInvariantInput } from './invariant.contract'

const AGE_MS = FINANCE_THRESHOLDS.transferPendingHours * 60 * 60_000
const defaultClock: InvariantClock = { now: () => new Date() }

export const FIN_I_010: StuckInvariant = {
  code: FINANCE_INVARIANT_CODES.STUCK_TRANSFER_PENDING,
  scope: 'stuck',
  description: 'Transfer.PENDING depuis plus de 2 h hors mission DISPUTE_OPEN.',
  defaultSeverity: 'P2',

  apply(input: StuckInvariantInput, clock?: InvariantClock): InvariantBreak | null {
    if (input.kind !== 'TRANSFER') return null
    const { transfer, missionStatus } = input
    if (transfer.status !== 'PENDING') return null
    if (missionStatus === 'DISPUTE_OPEN') return null
    const ageMs = (clock ?? defaultClock).now().getTime() - transfer.updatedAt.getTime()
    if (ageMs < AGE_MS) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.STUCK_TRANSFER_PENDING,
      mismatchType: 'STUCK_PENDING',
      resourceKind: 'TRANSFER',
      resourceId: transfer.id,
      severity: 'P2',
      explanation: `Transfer.PENDING depuis ${(ageMs / 3_600_000).toFixed(1)} h. Mission status=${missionStatus ?? 'unknown'}.`,
      remediationHint:
        'Vérifier la queue BullMQ `stripe-transfers` (job stalled ou worker down). ' +
        'Si Stripe API a renvoyé une erreur transient, le retry exponentiel devrait reprendre — surveiller DLQ.',
      dbSnapshot: sanitizeForFinanceSnapshot('TRANSFER', transfer),
      stripeSnapshot: null,
    }
  },
}
