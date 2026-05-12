/**
 * PRD-004 Ticket 4.2 — Helper jitter pour retry exponentiel.
 *
 * Pourquoi du jitter ?
 *  - Sans jitter, après une panne Stripe / Redis / Cloudinary, tous les jobs
 *    en attente retentent au **même** instant T0 + 5min → pic de charge
 *    coordonné qui peut re-tomber l'API en panne (« retry storm »).
 *  - Le jitter ± `RETRY_JITTER_RATIO` (10 %) étale l'envoi sur une fenêtre
 *    autour de la date cible, évitant la synchronisation des workers.
 *
 * Politique CTO :
 *  - Jitter symétrique ± 10 % du délai cible.
 *  - Implémenté en `Math.random()` (non-cryptographique, suffisant pour
 *    désynchroniser des workers — règle securite : `crypto.randomBytes`
 *    réservé aux tokens / secrets).
 *  - Floor à 1s : jamais un retry négatif ou nul (ce qui bypasse le delay
 *    BullMQ).
 */

/** Ratio de jitter ± autour du délai cible (10 %). */
export const RETRY_JITTER_RATIO = 0.1

/** Floor minimum d'un délai après jitter, en ms. */
export const RETRY_MIN_DELAY_MS = 1_000

export interface JitterOpts {
  /** Délai cible en ms (avant jitter). */
  delayMs: number
  /** Override le RNG pour les tests déterministes (retourne [0, 1[). */
  random?: () => number
}

/**
 * Applique un jitter ± `RETRY_JITTER_RATIO` au délai cible.
 *
 * Garanties :
 *  - jamais < `RETRY_MIN_DELAY_MS`.
 *  - jamais > `delayMs * (1 + RETRY_JITTER_RATIO)`.
 *  - moyenne mathématique = `delayMs` (jitter symétrique).
 *
 * Exemple : `applyJitter({ delayMs: 60_000 })` retourne un nombre entre
 * 54_000 ms et 66_000 ms (60s ± 6s).
 */
export function applyJitter(opts: JitterOpts): number {
  const rng = opts.random ?? Math.random
  const ratio = RETRY_JITTER_RATIO
  // `rng()` ∈ [0, 1[ → on mappe vers [-ratio, +ratio[
  const offset = (rng() * 2 - 1) * ratio
  const jittered = Math.round(opts.delayMs * (1 + offset))
  return Math.max(RETRY_MIN_DELAY_MS, jittered)
}
