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
 * PRD-004 Ticket 4.2 — Safety-net cron (AC-4.2.4.1).
 *
 * `AUTO_RELEASE_SAFETY_GRACE_MS` :
 *  - Délai après `scheduledFor` au-delà duquel un job SCHEDULED est jugé
 *    « perdu côté BullMQ » et doit être ré-enqueue par le cron horaire.
 *  - 30 min : large pour couvrir le délai BullMQ standard + tolérance worker
 *    en charge, sans laisser pourrir un job pendant des heures.
 *
 * `AUTO_RELEASE_STUCK_LOCK_MS` :
 *  - Délai après `lockedAt` au-delà duquel on considère qu'un worker a
 *    crashé sans relâcher son lock applicatif (audit V10).
 *  - 10 min : un `capture` Stripe + transaction DB tient < 30 s en p99, on
 *    laisse 20× de marge avant d'arracher le lock.
 *
 * `AUTO_RELEASE_SAFETY_LIMIT` :
 *  - Borne max de jobs traités par tick cron (évite de surcharger un worker
 *    si la file s'accumule lors d'un incident). 100 = ~10s de travail si
 *    chaque job prend ~100 ms.
 */
export const AUTO_RELEASE_SAFETY_GRACE_MS = 30 * 60 * 1_000
export const AUTO_RELEASE_STUCK_LOCK_MS = 10 * 60 * 1_000
export const AUTO_RELEASE_SAFETY_LIMIT = 100

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
