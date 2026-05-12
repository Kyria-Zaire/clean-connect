import { MissionStatusSchema, type MissionStatus } from '@cc/shared-types'

/**
 * Graphe de transitions **MVP PRD-002 + PRD-003 Tickets 3.2 / 3.4**.
 *
 * Modélisation :
 *  - PRD-002 Build : `DRAFT → PUBLISHED → ACCEPTED|EXPIRED|CANCELLED`
 *    (préservé tant que `FF_PAYMENTS_ENABLED=false` — rétro-compatibilité).
 *  - PRD-003 Ticket 3.2 : `DRAFT → PENDING_PAYMENT → PUBLISHED | CANCELLED`.
 *    `PENDING_PAYMENT → PUBLISHED` est exclusivement déclenchée par le
 *    webhook Stripe `payment_intent.amount_capturable_updated` (jamais par
 *    une route API utilisateur — cf. correction CTO Ticket 3.2).
 *  - PRD-003 Ticket 3.4 (mission completion + capture) :
 *      `ACCEPTED → CLIENT_VALIDATION_PENDING` (POST /complete, prestataire,
 *      garde-fou photos ≥ 3 BEFORE + ≥ 5 AFTER syncées).
 *      `CLIENT_VALIDATION_PENDING → COMPLETED` (webhook
 *      `payment_intent.succeeded` après capture confirmée — jamais
 *      directement depuis une route HTTP).
 *      `CLIENT_VALIDATION_PENDING → DISPUTE_OPEN` (POST /report-problem,
 *      client owner — bloque l'auto-release T+48h ouvrées).
 *  - L'état intermédiaire `PROPOSED` est *réservé* (présent dans l'enum DB)
 *    mais non utilisé en marketplace : les propositions sont matérialisées
 *    par les lignes `MissionProposal` ; le statut mission reste `PUBLISHED`
 *    pendant la fenêtre TTL.
 *  - `IN_PROGRESS` reste réservé à un futur endpoint `/start` (mobile)
 *    dédié — non livré en 3.4 (cf. PRD §5.1quater, `TODO(debt)
 *    mission-start-endpoint`).
 *  - `REFUNDED` = Ticket 3.5. `COMPLETED → DISPUTE_OPEN` : webhook
 *    `transfer.reversed` (Ticket 3.5) **ou** fenêtre 7 j post completion (PRD-005).
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
  // PRD-003 Ticket 3.4 — prestataire peut directement `complete` une mission
  // ACCEPTED (les photos AFTER sont uploadées au fil de la prestation via
  // les routes presign/confirm). L'état IN_PROGRESS n'est pas un prérequis
  // serveur en 3.4 (TODO(debt) mission-start-endpoint).
  ACCEPTED: ['CLIENT_VALIDATION_PENDING', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: [],
  IN_PROGRESS: ['CLIENT_VALIDATION_PENDING', 'CANCELLED'],
  // PRD-003 Ticket 3.4 — transitions sortantes :
  //   → COMPLETED : webhook `payment_intent.succeeded` (capture confirmée).
  //   → DISPUTE_OPEN : POST /report-problem (CLIENT) ou
  //                    `charge.dispute.created` (Ticket 3.5).
  CLIENT_VALIDATION_PENDING: ['COMPLETED', 'DISPUTE_OPEN', 'CANCELLED'],
  // PRD-003 Ticket 3.5 — `COMPLETED → DISPUTE_OPEN` si `transfer.reversed`
  // (reversal Stripe / compte fermé). Fenêtre litige client T+7j = PRD-005.
  COMPLETED: ['DISPUTE_OPEN'],
  // PRD-003 Ticket 3.4 — terminal MVP (workflow litige complet = PRD-005).
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
