/**
 * `FIN-J-001` — Invariant comptable journalier.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Formule (J-1, Europe/Paris) :
 *   capturedSum - transferSentSum - refundedSum - applicationFeeSum  ≈ 0
 *   (tolérance : `FINANCE_THRESHOLDS.invariantBalanceToleranceCents` cents)
 *
 * Si rompu : `finance_invariant_break` (P1) + bloque la génération `success` du
 * daily report (le report est marqué `failed` → alerte ops).
 */

import { FINANCE_INVARIANT_CODES, FINANCE_THRESHOLDS } from '../finance.constants'

import type { DailyInvariant, DailyInvariantInput, InvariantBreak } from './invariant.contract'

export const FIN_J_001: DailyInvariant = {
  code: FINANCE_INVARIANT_CODES.DAILY_BALANCE,
  scope: 'daily',
  description: 'capturedSum - transferSentSum - refundedSum - applicationFeeSum ≈ 0 (tolérance 1 cent).',
  defaultSeverity: 'P1',

  apply(input: DailyInvariantInput): InvariantBreak | null {
    const balance =
      input.capturedSumCents -
      input.transferSentSumCents -
      input.refundedSumCents -
      input.applicationFeeSumCents

    if (Math.abs(balance) <= FINANCE_THRESHOLDS.invariantBalanceToleranceCents) return null

    const reportLabel = isoDateOnly(input.reportDate)

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.DAILY_BALANCE,
      mismatchType: 'INVARIANT_SUM',
      resourceKind: 'INVARIANT',
      resourceId: `J-1:${reportLabel}`,
      severity: 'P1',
      explanation:
        `Balance J-1 (${reportLabel}) = ${balance} cents (capt=${input.capturedSumCents} ` +
        `- trSent=${input.transferSentSumCents} - refund=${input.refundedSumCents} ` +
        `- fee=${input.applicationFeeSumCents}). Tolérance ±${FINANCE_THRESHOLDS.invariantBalanceToleranceCents} cent.`,
      remediationHint:
        'Lister les Payment/Transfer/Refund de J-1 et croiser ligne par ligne. ' +
        'Souvent : Refund posté à cheval sur minuit ou Transfer reversé non comptabilisé. ' +
        'Bloquer toute génération de daily-report success tant que non résolu.',
      amountDeltaCents: balance,
      dbSnapshot: {
        invariant: 'FIN-J-001',
        reportDate: reportLabel,
        leftCents: input.capturedSumCents,
        rightCents:
          input.transferSentSumCents + input.refundedSumCents + input.applicationFeeSumCents,
        deltaCents: balance,
      },
      stripeSnapshot: null,
    }
  },
}

function isoDateOnly(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
