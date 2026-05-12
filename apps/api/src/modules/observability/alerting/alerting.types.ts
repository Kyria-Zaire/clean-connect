/**
 * PRD-004 Ticket 4.1 (Build B) — types & constants pour Alerting.
 *
 * Source de vérité : ADR-017 §3 matrice sévérité × dispatch.
 */

/**
 * Niveau de sévérité.
 *
 * | Niveau | Cible           | Cooldown |
 * |--------|-----------------|----------|
 * | P0     | Discord immédiat | 5 min   |
 * | P1     | Discord immédiat | 5 min   |
 * | P2     | Discord agrégé (flush 60s) | 60s |
 * | P3     | Logs only       | n/a      |
 */
export const ALERT_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

/**
 * Catégorie d'alerte — borne stricte, jamais de string libre côté caller.
 * Cardinalité ≤ 16 pour rester sous contrôle (rule observabilité).
 */
export const ALERT_KINDS = [
  // PRD-004 Build B — set minimum exigé CTO.
  'webhook_failed_rate',
  'dlq_growth',
  'stripe_api_failure_spike',
  'bullmq_failed_jobs',
  'metrics_endpoint_down',
  // Réservés futures itérations (PRD-004 Tickets 4.2 → 4.5).
  'stuck_transfer',
  'refund_anomaly',
  'auto_release_stalled',
  'rgpd_export_failure',
  'reconcile_mismatch',
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

export interface AlertPayload {
  /** Sévérité — drive le dispatch (immédiat vs agrégé). */
  severity: AlertSeverity
  /** Catégorie bornée. */
  kind: AlertKind
  /** Titre court (≤ 96 chars). Sanitisé via `deepSanitize`. */
  title: string
  /** Description (≤ 1024 chars). Sanitisée via `deepSanitize` + `redactSecretsInString`. */
  description?: string
  /**
   * Métriques contextuelles — sanitisées via `deepSanitize`. Ne JAMAIS passer
   * userId/missionId/email/paymentIntentId ici → l'API ne le rejette pas mais
   * `sanitizeForAlert` retournera `[REDACTED]` pour les clés sensibles connues.
   */
  context?: Record<string, unknown>
}

/**
 * Map sévérité → couleur Discord embed (RGB hex décimal).
 *  - P0 = rouge vif (0xFF0000)
 *  - P1 = orange   (0xFF8800)
 *  - P2 = jaune    (0xFFEE00)
 *  - P3 = bleu info(0x3B82F6)
 */
export const ALERT_COLORS: Readonly<Record<AlertSeverity, number>> = Object.freeze({
  P0: 0xff0000,
  P1: 0xff8800,
  P2: 0xffee00,
  P3: 0x3b82f6,
})
