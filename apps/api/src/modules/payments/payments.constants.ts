/**
 * PRD-003 Ticket 3.1 — constantes Payments (queues BullMQ, retries, idempotence).
 *
 * Source de vérité unique pour les noms de queues / jobs / clés idempotence.
 * Tout fichier qui ajoute / mute un job DOIT importer depuis ici.
 */

/** Queue BullMQ — ingestion + dispatch des webhooks Stripe (Ticket 3.1+). */
export const STRIPE_WEBHOOK_QUEUE = 'stripe-webhooks'

/** Nom du job individuel posé sur `STRIPE_WEBHOOK_QUEUE`. */
export const STRIPE_WEBHOOK_PROCESS_JOB = 'process'

/**
 * Retries max d'un job webhook (audit Verify V1).
 * 5 = recommandation rule stripe + ADR-008. Au-delà → DLQ + alerte ops.
 */
export const STRIPE_WEBHOOK_MAX_ATTEMPTS = 5

/**
 * Backoff exponentiel de base (en ms). Suite : 30s → 1m → 2m → 4m → 8m.
 * Reste sous la fenêtre de retry Stripe (jusqu'à 3 jours) → on garde la main.
 */
export const STRIPE_WEBHOOK_BACKOFF_BASE_MS = 30_000

/**
 * Bus event interne (Build futur Tickets 3.2+) — non utilisé en 3.1.
 * Placeholder déclaré ici pour éviter une refacto cross-module ultérieure.
 */
export const PAYMENTS_DOMAIN_EVENT_QUEUE = 'payments-domain-events'
