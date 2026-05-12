import { MissionStatusSchema, type MissionStatus } from '@cc/shared-types'

/**
 * Graphe de transitions **MVP PRD-002 + PRD-003 Ticket 3.2**.
 *
 * Modélisation :
 *  - PRD-002 Build : `DRAFT → PUBLISHED → ACCEPTED|EXPIRED|CANCELLED`
 *    (préservé tant que `FF_PAYMENTS_ENABLED=false` — rétro-compatibilité).
 *  - PRD-003 Ticket 3.2 : `DRAFT → PENDING_PAYMENT → PUBLISHED | CANCELLED`.
 *    `PENDING_PAYMENT → PUBLISHED` est exclusivement déclenchée par le
 *    webhook Stripe `payment_intent.amount_capturable_updated` (jamais par
 *    une route API utilisateur — cf. correction CTO Ticket 3.2).
 *  - L'état intermédiaire `PROPOSED` est *réservé* (présent dans l'enum DB)
 *    mais non utilisé en marketplace : les propositions sont matérialisées
 *    par les lignes `MissionProposal` ; le statut mission reste `PUBLISHED`
 *    pendant la fenêtre TTL.
 *  - États aval (IN_PROGRESS, AWAITING_CLIENT_VALIDATION, COMPLETED,
 *    DISPUTE_OPEN, REFUNDED) déclarés pour PRD-003 Ticket 3.4+ : aucune
 *    transition ici en 3.2.
 *
 * Règle produit : toute mutation de statut côté API DOIT passer par
 * `assertMissionTransition()` (contrainte CTO Build §6).
 */
export const MISSION_TRANSITIONS_MVP: {
  readonly [S in MissionStatus]: readonly MissionStatus[]
} = {
  // Note : `DRAFT → PUBLISHED` reste autorisé pour la rétro-compat PRD-002
  // (FF off). Côté service, `MissionsService.publish()` rejette cette
  // transition quand `FF_PAYMENTS_ENABLED=true` pour forcer le passage par
  // `POST /v1/payments/intent` → `PENDING_PAYMENT` → webhook → `PUBLISHED`.
  DRAFT: ['PENDING_PAYMENT', 'PUBLISHED', 'CANCELLED'],
  PENDING_PAYMENT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['ACCEPTED', 'EXPIRED', 'CANCELLED'],
  PROPOSED: ['ACCEPTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: [],
  EXPIRED: [],
  CANCELLED: [],
  IN_PROGRESS: [],
  AWAITING_CLIENT_VALIDATION: [],
  COMPLETED: [],
  DISPUTE_OPEN: [],
  REFUNDED: [],
}

export function isMissionStatus(value: unknown): value is MissionStatus {
  return MissionStatusSchema.safeParse(value).success
}

export function canTransitionMissionStatus(from: MissionStatus, to: MissionStatus): boolean {
  const allowed = MISSION_TRANSITIONS_MVP[from]
  return (allowed as readonly MissionStatus[]).includes(to)
}

export class MissionInvalidStatusTransitionError extends Error {
  constructor(
    readonly from: MissionStatus,
    readonly to: MissionStatus,
  ) {
    super(`Transition de statut mission interdite: ${from} → ${to}`)
    this.name = 'MissionInvalidStatusTransitionError'
  }
}

/** Lance si la transition n'est pas autorisée (Build : intercepter → HTTP 409). */
export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMissionStatus(from, to)) {
    throw new MissionInvalidStatusTransitionError(from, to)
  }
}
