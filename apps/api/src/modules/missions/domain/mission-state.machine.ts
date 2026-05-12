import { MissionStatusSchema, type MissionStatus } from '@cc/shared-types'

/**
 * Graphe de transitions **MVP PRD-002 Build** (Discover validé CTO 2026-05-12,
 * affiné Build conformément à ADR-005 marketplace first-accept-wins).
 *
 * Modélisation :
 *  - `DRAFT → PUBLISHED → ACCEPTED|EXPIRED|CANCELLED`.
 *  - L'état intermédiaire `PROPOSED` est *réservé* (présent dans l'enum DB)
 *    mais non utilisé en marketplace : les propositions sont matérialisées
 *    par les lignes `MissionProposal` ; le statut mission reste `PUBLISHED`
 *    pendant la fenêtre TTL.
 *  - États aval (IN_PROGRESS, AWAITING_CLIENT_VALIDATION, COMPLETED,
 *    DISPUTE_OPEN, REFUNDED) déclarés pour PRD-003+ : aucune transition ici.
 *
 * Règle produit : toute mutation de statut côté API DOIT passer par
 * `assertMissionTransition()` (contrainte CTO Build §6).
 */
export const MISSION_TRANSITIONS_MVP: {
  readonly [S in MissionStatus]: readonly MissionStatus[]
} = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
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
