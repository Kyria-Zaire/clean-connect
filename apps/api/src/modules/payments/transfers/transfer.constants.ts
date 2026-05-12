/**
 * PRD-003 Ticket 3.5 — outbound Transfer Connect (Stripe `transfers.create`).
 */

export const TRANSFER_RETRY_QUEUE = 'transfer-retry'

export const TRANSFER_RETRY_JOB = 'retry-outbound-transfer'

/** 5 min, 15 min, 1 h, 6 h, 24 h — décision CTO Ticket 3.5 (après 5 échecs → FAILED + DLQ/alerte). */
export const TRANSFER_RETRY_BACKOFF_MS = [
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
] as const

/** Tentatives Stripe/API au total (1ère tentative + 4 replanifiées max) — alignement CTO. */
export const TRANSFER_MAX_API_ATTEMPTS = 5

/** Idempotency Stripe — déterministe (anti double payout). */
export function buildTransferStripeIdempotencyKey(missionId: string): string {
  return `transfer-mission-${missionId}`
}

export function buildTransferRetryBullJobId(transferId: string, attempt: number): string {
  return `transfer-retry-${transferId}-a${attempt}`
}

/** Seuil cron réconciliation — Transfer `PENDING` / `RETRY_SCHEDULED` sans update > 2 h. */
export const TRANSFER_RECONCILE_STALE_MS = 2 * 60 * 60 * 1_000
