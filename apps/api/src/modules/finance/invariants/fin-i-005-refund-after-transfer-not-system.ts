/**
 * `FIN-I-005` — `Refund après Transfer.SENT ⇒ initiatedBy != SYSTEM`.
 *
 * Source : ADR-018 §3 + PRD-004 §4.15.5.
 *
 * Détection : un refund émis après libération du séquestre (Transfer.SENT) DOIT
 * être manuel (initiatedBy = ID admin) car cela implique un ré-débit du
 * prestataire — décision humaine obligatoire (RBAC + audit).
 *
 * Sévérité : P1.
 */

import { sanitizeForFinanceSnapshot } from '../finance-snapshot.sanitizer'
import { FINANCE_INVARIANT_CODES } from '../finance.constants'

import type { InvariantBreak, PaymentInvariantInput, ReconcileInvariant } from './invariant.contract'

export const FIN_I_005: ReconcileInvariant = {
  code: FINANCE_INVARIANT_CODES.REFUND_AFTER_TRANSFER_NOT_AUTOMATIC,
  scope: 'reconcile',
  description: 'Refund post-Transfer.SENT doit être déclenché par un admin (pas SYSTEM).',
  defaultSeverity: 'P1',

  apply({ transfer, refunds }: PaymentInvariantInput): InvariantBreak | null {
    if (!transfer || transfer.status !== 'SENT') return null

    const refundsAfterTransfer = refunds.filter(
      (r) =>
        r.status !== 'FAILED' &&
        r.createdAt.getTime() >= transfer.updatedAt.getTime() &&
        (!r.initiatedBy || r.initiatedBy === 'SYSTEM'),
    )

    const offending = refundsAfterTransfer[0]
    if (!offending) return null

    return {
      mismatchCode: FINANCE_INVARIANT_CODES.REFUND_AFTER_TRANSFER_NOT_AUTOMATIC,
      mismatchType: 'STATUS',
      resourceKind: 'REFUND',
      resourceId: offending.id,
      severity: 'P1',
      explanation:
        `Refund.id=${offending.id} émis après Transfer.SENT avec initiatedBy="${offending.initiatedBy ?? 'null'}" ` +
        `(attendu un identifiant admin). Risque : refund automatique non audité après libération du séquestre.`,
      remediationHint:
        'Bloquer immédiatement le refund (admin investigation). Identifier le code qui a déclenché le refund ' +
        'sans actorUserId — toute opération post-SENT doit obligatoirement venir d\'un endpoint admin authentifié.',
      dbSnapshot: sanitizeForFinanceSnapshot('REFUND', offending),
      stripeSnapshot: null,
    }
  },
}
