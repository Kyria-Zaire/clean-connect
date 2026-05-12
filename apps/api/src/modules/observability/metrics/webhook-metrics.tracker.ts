/**
 * WebhookMetricsTracker — instrumentation pipeline webhook Stripe.
 * Source de vérité : cahier CTO PRD-004 §A3-bis.
 *
 * Trois métriques alimentées :
 *  - `cleanconnect_webhook_processing_total{event_type, outcome}` — counter
 *  - `cleanconnect_webhook_processing_failures_total{event_type, outcome}`
 *    — counter (subset avec outcome ∈ {rejected, failed})
 *  - `cleanconnect_webhook_processing_duration_seconds{event_type, outcome}`
 *    — histogram
 *
 * **Labels autorisés uniquement** : `event_type` + `outcome`.
 * `outcome` ∈ {accepted, rejected, replayed, failed} (cardinalité 4).
 * `event_type` = type Stripe normalisé (whitelist + `'unknown'`).
 *
 * **Aucun payload, aucun secret** : on n'utilise jamais le body brut ni
 * `event.id` (UUID, cardinalité infinie). Logs séparés gérés par Pino.
 */

import { Injectable } from '@nestjs/common'

import { MetricsService } from './metrics.service'

/**
 * Whitelist des outcomes — bornée pour stabilité dashboard/alertes.
 */
export const WEBHOOK_OUTCOMES = ['accepted', 'rejected', 'replayed', 'failed'] as const
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number]

/**
 * Whitelist statique des Stripe event types observés / catalogués Clean
 * Connect. Tout type hors whitelist tombe sur `'unknown'` pour borner la
 * cardinalité. Étendre cette liste avec parcimonie (chaque entrée crée
 * jusqu'à 4 séries — une par outcome).
 *
 * Liste alignée sur :
 *  - PRD-003 §Bloc 3 (mapping handlers Payment/Transfer/Refund)
 *  - `payment-domain.handler.ts` / `transfer-domain.handler.ts` / `refund-domain.handler.ts`
 */
export const KNOWN_STRIPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'payment_intent.created',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'payment_intent.payment_failed',
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
  'transfer.failed',
  'account.updated',
])

/**
 * Pattern conservateur pour valider la forme `<resource>.<action>` Stripe.
 * Si match → on garde la valeur (déjà bornée par l'API Stripe à ~80 types).
 * Si pas match → `unknown` (anti-cardinalité).
 *
 * On accepte les types HORS whitelist mais avec forme valide — utile pour
 * détecter les nouveaux types Stripe sans avoir à rebuilder. La whitelist
 * `KNOWN_STRIPE_EVENT_TYPES` reste la référence pour les dashboards.
 */
const STRIPE_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/

@Injectable()
export class WebhookMetricsTracker {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Enregistre une observation complète : counter + histogram.
   * `durationSeconds` peut être 0 quand l'outcome est connu avant tout
   * traitement (ex: signature rejetée — `rejected` sans latence pertinente).
   */
  observe(rawEventType: string | undefined, outcome: WebhookOutcome, durationSeconds: number): void {
    const event_type = normalizeEventType(rawEventType)
    this.metrics.webhookProcessingTotal.inc({ event_type, outcome })
    this.metrics.webhookProcessingDurationSeconds.observe({ event_type, outcome }, durationSeconds)
    if (outcome === 'rejected' || outcome === 'failed') {
      this.metrics.webhookProcessingFailuresTotal.inc({ event_type, outcome })
    }
  }

  /**
   * Sucre syntaxique — pour outcomes sans latence pertinente (ingestion
   * synchrone : on incrémente avec `durationSeconds = 0`).
   */
  recordOutcome(rawEventType: string | undefined, outcome: WebhookOutcome): void {
    this.observe(rawEventType, outcome, 0)
  }
}

/**
 * Normalise un event_type Stripe en label borné. Exposé pour les tests.
 *
 * Règles :
 *  - vide / non-string → `'unknown'`
 *  - whitelist hit → renvoyé tel quel
 *  - pattern hit → renvoyé tel quel (autorise nouveaux types Stripe)
 *  - sinon → `'unknown'`
 */
export function normalizeEventType(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown'
  if (raw.length > 64) return 'unknown'
  if (KNOWN_STRIPE_EVENT_TYPES.has(raw)) return raw
  if (STRIPE_EVENT_TYPE_PATTERN.test(raw)) return raw
  return 'unknown'
}
