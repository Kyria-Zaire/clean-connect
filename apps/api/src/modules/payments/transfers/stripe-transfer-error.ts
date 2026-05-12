/**
 * PRD-004 Ticket 4.2 — Classification des erreurs Stripe `transfers.create`.
 *
 * Politique CTO (AC-4.2.1.1 et AC-4.2.1.2) :
 *  - `transient`   → retryable, planifié sur la file `TRANSFER_RETRY_QUEUE`
 *                    avec backoff exponentiel (5min, 15min, 1h, 6h, 24h).
 *  - `permanent`   → **pas de retry**, bascule direct en `Transfer.FAILED`
 *                    + alerte P1 admin. L'admin peut faire un retry manuel
 *                    (route existante `POST /v1/admin/transfers/:id/retry`)
 *                    s'il a corrigé l'environnement (KYC, capabilities…).
 *
 * Source : Stripe API docs + retours terrain ADR-008 PRD-003.
 *
 * Sécurité :
 *  - On ne classe **jamais** sur le message brut de l'erreur (risque PII /
 *    cardinalité). Uniquement sur `code` / `type` Stripe + statut HTTP.
 */

import type Stripe from 'stripe'

export type StripeTransferErrorKind = 'transient' | 'permanent' | 'unknown'

/**
 * Codes Stripe terminaux — JAMAIS retryés automatiquement.
 *
 * `account_closed`           → le compte connecté est fermé chez Stripe.
 * `transfer_already_paid`    → un payout existe déjà côté Stripe sur ce
 *                              source_transaction (signe d'incohérence DB).
 * `insufficient_funds_to_be_transferred` → solde plateforme < montant.
 *                              Action humaine requise (alerte CTO).
 * `parameter_invalid_empty`  → bug applicatif côté Clean Connect.
 * `parameter_invalid_integer`→ bug applicatif côté Clean Connect.
 * `parameter_unknown`        → bug applicatif côté Clean Connect.
 */
const PERMANENT_STRIPE_CODES: ReadonlySet<string> = new Set([
  'account_closed',
  'transfer_already_paid',
  'insufficient_funds_to_be_transferred',
  'parameter_invalid_empty',
  'parameter_invalid_integer',
  'parameter_unknown',
  // Capabilities pour Connect Express — si KYC non finalisé, c'est permanent
  // jusqu'à action prestataire. On préfère alerter qu'enchainer 5 retries
  // inutiles (rule stripe : « jamais de payout sans KYC complet »).
  'account_capabilities_required',
])

/**
 * Types Stripe transients — toujours retryés (sauf si code permanent ci-dessus).
 *
 * - `api_connection_error`   : réseau / DNS / TLS
 * - `api_error`              : 5xx générique côté Stripe
 * - `rate_limit_error`       : 429 Stripe (jamais en local mais possible
 *                              sur webhook burst en prod)
 * - `idempotency_error`      : Stripe ne reconnaît pas la clé idempotency
 *                              (transitoire — rare).
 */
const TRANSIENT_STRIPE_TYPES: ReadonlySet<string> = new Set([
  'api_connection_error',
  'api_error',
  'rate_limit_error',
  'idempotency_error',
])

export interface ClassifiedStripeError {
  kind: StripeTransferErrorKind
  /** Slug compact stable pour logs/metrics. */
  code: string
  /** Statut HTTP Stripe si dispo (utile aux logs structurés). */
  statusCode: number | null
}

/**
 * Classifie une erreur levée par `stripe.transfers.create`.
 *
 * - Renvoie `permanent` si on reconnaît un code/erreur terminal.
 * - Renvoie `transient` pour les types réseau / 5xx / rate-limit / idempotency.
 * - Renvoie `unknown` (traité comme transient — fail-open côté retry) sinon.
 *
 * Le caller décide :
 *  - `permanent` → `Transfer.FAILED` terminal direct.
 *  - `transient` / `unknown` → enqueue `TRANSFER_RETRY_QUEUE` (avec backoff
 *    DB-driven, pas BullMQ-driven — cf. `transfer-retry.processor.ts`).
 */
export function classifyStripeTransferError(err: unknown): ClassifiedStripeError {
  if (err instanceof Error && 'type' in err) {
    const stripeErr = err as Stripe.errors.StripeError
    const code = typeof stripeErr.code === 'string' ? stripeErr.code : 'unknown'
    const type = typeof stripeErr.type === 'string' ? stripeErr.type : 'unknown'
    const statusCode = typeof stripeErr.statusCode === 'number' ? stripeErr.statusCode : null

    if (PERMANENT_STRIPE_CODES.has(code)) {
      return { kind: 'permanent', code, statusCode }
    }
    if (TRANSIENT_STRIPE_TYPES.has(type)) {
      return { kind: 'transient', code, statusCode }
    }
    if (statusCode !== null && statusCode >= 500 && statusCode < 600) {
      return { kind: 'transient', code: code === 'unknown' ? 'http_5xx' : code, statusCode }
    }
    return { kind: 'unknown', code, statusCode }
  }
  return { kind: 'unknown', code: 'non_stripe_error', statusCode: null }
}
