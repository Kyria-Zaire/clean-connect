/**
 * PRD-004 Ticket 4.5 Build itération 2 — Registry des invariants.
 *
 * Tous les invariants sont enregistrés ici, regroupés par scope. Les services
 * (`FinanceReconcileService`, `FinanceStuckFundsService`, `FinanceInvariantsService`)
 * importent UNIQUEMENT le registry — pas les invariants individuels — pour éviter
 * les imports désordonnés et garantir l'exhaustivité (un invariant non enregistré
 * = invariant invisible côté schedulers).
 */

import { FIN_I_001 } from './fin-i-001-captured-requires-amount'
import { FIN_I_002 } from './fin-i-002-transfer-sent-implies-captured'
import { FIN_I_003 } from './fin-i-003-transfer-amount-equals-provider-payout'
import { FIN_I_004 } from './fin-i-004-refund-implies-captured-or-refunded'
import { FIN_I_005 } from './fin-i-005-refund-after-transfer-not-system'
import { FIN_I_006 } from './fin-i-006-stripe-pi-amount-matches-db'
import { FIN_I_007 } from './fin-i-007-stripe-transfer-amount-matches-db'
import { FIN_I_008 } from './fin-i-008-stripe-refund-amount-matches-db'
import { FIN_I_009 } from './fin-i-009-stuck-authorization'
import { FIN_I_010 } from './fin-i-010-stuck-transfer-pending'
import { FIN_I_011 } from './fin-i-011-stuck-captured-without-transfer'
import { FIN_J_001 } from './fin-j-001-daily-balance'
import type { DailyInvariant, ReconcileInvariant, StuckInvariant } from './invariant.contract'

export const RECONCILE_INVARIANTS: readonly ReconcileInvariant[] = Object.freeze([
  FIN_I_001,
  FIN_I_002,
  FIN_I_003,
  FIN_I_004,
  FIN_I_005,
  FIN_I_006,
  FIN_I_007,
  FIN_I_008,
])

export const STUCK_INVARIANTS: readonly StuckInvariant[] = Object.freeze([
  FIN_I_009,
  FIN_I_010,
  FIN_I_011,
])

export const DAILY_INVARIANTS: readonly DailyInvariant[] = Object.freeze([FIN_J_001])

export const ALL_INVARIANT_CODES: readonly string[] = Object.freeze([
  ...RECONCILE_INVARIANTS.map((i) => i.code),
  ...STUCK_INVARIANTS.map((i) => i.code),
  ...DAILY_INVARIANTS.map((i) => i.code),
])
