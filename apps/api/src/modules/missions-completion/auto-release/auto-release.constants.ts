/**
 * PRD-003 Ticket 3.4 — constantes BullMQ auto-release.
 *
 * Source de vérité unique pour les noms de queue / job / clés idempotence
 * (rule architecte-api : `apps/api/src/modules/payments/payments.constants.ts`
 * suit la même convention).
 */

/** Queue BullMQ — escrow auto-release (delayed jobs T+48h ouvrées + safety-net). */
export const AUTO_RELEASE_QUEUE = 'escrow-auto-release'

/** Nom du job individuel posté sur `AUTO_RELEASE_QUEUE`. */
export const AUTO_RELEASE_PROCESS_JOB = 'process'

/**
 * Heures ouvrées avant déclenchement du job (Design AC-D.4 + cahier v1.4).
 * **Ne PAS modifier** sans nouvel ADR + signoff CTO.
 */
export const AUTO_RELEASE_BUSINESS_HOURS = 48

/**
 * Retries max d'un job auto-release. À l'épuisement → DLQ (Ticket 3.5).
 * MVP : 3 essais (audit Verify V3 — un seul Stripe `paymentIntents.capture`
 * appelé grâce à l'idempotency-key).
 */
export const AUTO_RELEASE_MAX_ATTEMPTS = 3

/** Backoff exponentiel base (ms) — 30s → 1m → 2m. */
export const AUTO_RELEASE_BACKOFF_BASE_MS = 30_000

/**
 * Build le `bullJobId` **déterministe** pour une mission.
 *
 * Garanties :
 *  - BullMQ déduplique : un second `queue.add` avec le même `jobId` retourne
 *    le job existant (audit Verify V3 — anti double payout).
 *  - Permet `queue.remove(bullJobId)` lors d'un `validate` / `report-problem`.
 */
export function buildAutoReleaseBullJobId(missionId: string): string {
  return `auto-release-mission-${missionId}`
}

/**
 * Build l'`idempotencyKey` **déterministe** pour la capture Stripe — voir
 * rule stripe (`capture-mission-{missionId}` est l'unique clé acceptée
 * pour la capture, qu'elle vienne du CLIENT, de l'auto-release ou d'un
 * admin exceptionnel).
 */
export function buildCaptureIdempotencyKey(missionId: string): string {
  return `capture-mission-${missionId}`
}
