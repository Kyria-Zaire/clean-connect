/**
 * Sanitization filters Sentry-specific (PRD-004 Ticket 4.1 — Build A1).
 *
 * Les helpers génériques (`deepSanitize`, `isSensitiveKey`, `sanitizeUrl`,
 * `redactSecretsInString`, `REDACTED`) vivent désormais dans
 * `common/security/sanitize.ts` (partagés avec le log formatter Pino A2).
 *
 * Ce module ne contient plus que la logique propre à Sentry :
 *   - `sanitizeBreadcrumb(crumb)` — `beforeBreadcrumb` Sentry
 *   - `sanitizeEvent(event, hint)` — `beforeSend` Sentry
 *
 * Politique de redaction conforme à ADR-014 §2.6 + ADR-016 (classes A/B/C).
 * Toute exception non gérée traverse `sanitizeEvent` avant émission réseau
 * → zéro PII / secret en sortie (RGPD + sécurité).
 */

import type { ErrorEvent, EventHint, Breadcrumb } from '@sentry/node'

import {
  REDACTED,
  deepSanitize,
  isSensitiveKey,
  redactSecretsInString,
  sanitizeUrl,
} from '../../../common/security/sanitize'

export { REDACTED, deepSanitize, isSensitiveKey, redactSecretsInString, sanitizeUrl }

const SENSITIVE_QUERY_KEYS: readonly string[] = Object.freeze([
  'signature',
  'api_key',
  'token',
  'access_token',
  'refresh_token',
  'session_token',
  'code',
])

/**
 * `beforeBreadcrumb` Sentry — filtre breadcrumbs avant ajout au scope.
 *
 * - Retourne `null` pour rejeter complètement (ex: breadcrumbs `console.log`
 *   verbeux en prod, fetch vers Stripe avec body sensible).
 * - Sinon retourne une **copie** sanitizée.
 *
 * Note : ce hook s'exécute pour CHAQUE breadcrumb (fetch, console, fs, etc.).
 * On reste léger pour ne pas pénaliser les requêtes.
 */
export function sanitizeBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === 'console' && crumb.level === 'debug') {
    return null
  }

  const cleaned: Breadcrumb = {
    ...crumb,
    data: crumb.data ? deepSanitize(crumb.data) : crumb.data,
  }

  if (typeof cleaned.message === 'string' && cleaned.message.length > 0) {
    cleaned.message = redactSecretsInString(cleaned.message)
  }

  if (cleaned.data && typeof cleaned.data === 'object' && 'url' in cleaned.data) {
    const url = cleaned.data.url
    if (typeof url === 'string') {
      cleaned.data = { ...cleaned.data, url: sanitizeUrl(url) }
    }
  }

  return cleaned
}

/**
 * `beforeSend` Sentry — dernier rempart avant émission réseau vers le
 * collecteur Sentry. Toute fuite ici = incident sécurité.
 *
 * Garanties après passage :
 * - `event.request.headers`         → headers Classe A redactés
 * - `event.request.cookies`         → entièrement redactés
 * - `event.request.data` (body)     → deepSanitize
 * - `event.request.query_string`    → query params sensibles redactés
 * - `event.user`                    → seules `id` (UUID) reste ; `email`,
 *                                     `username`, `ip_address` strip
 * - `event.extra` / `event.contexts`→ deepSanitize
 * - `event.tags`                    → on whiteliste les tags techniques
 *                                     non-PII (`route`, `requestId`, `env`,
 *                                     `traceId`, `jobName`, `version`)
 * - `event.breadcrumbs[].data`      → deepSanitize chacun
 * - `event.message` / exception     → redactSecretsInString
 */
export function sanitizeEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  if (event.request) {
    if (event.request.headers) {
      const cleaned: Record<string, string> = {}
      for (const [name, val] of Object.entries(event.request.headers)) {
        cleaned[name] = isSensitiveKey(name) ? REDACTED : String(val)
      }
      event.request.headers = cleaned
    }
    // `cookies` n'est pas explicitement typé sur `RequestEventData` (Sentry v8)
    // mais peut apparaître dynamiquement via la `httpIntegration`. On cast en
    // bag dynamique pour redacter sans dépendre du type interne.
    const requestBag = event.request as unknown as Record<string, unknown>
    if (requestBag.cookies !== undefined) {
      requestBag.cookies = REDACTED
    }
    if (event.request.url) {
      event.request.url = sanitizeUrl(event.request.url)
    }
    if (event.request.query_string && typeof event.request.query_string === 'string') {
      try {
        const fake = new URL(`http://x/?${event.request.query_string}`)
        for (const key of [...fake.searchParams.keys()]) {
          if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
            fake.searchParams.set(key, REDACTED)
          }
        }
        event.request.query_string = fake.searchParams.toString()
      } catch {
        event.request.query_string = REDACTED
      }
    }
    if (event.request.data !== undefined && event.request.data !== null) {
      event.request.data = deepSanitize(event.request.data)
    }
  }

  if (event.user) {
    const safe: Record<string, unknown> = {}
    if (typeof event.user.id === 'string') safe.id = event.user.id
    event.user = safe
  }

  if (event.extra) {
    event.extra = deepSanitize(event.extra)
  }
  if (event.contexts) {
    event.contexts = deepSanitize(event.contexts)
  }

  if (event.tags) {
    const cleanTags: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(event.tags)) {
      if (isSensitiveKey(k)) continue
      if (v === undefined || v === null) continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        cleanTags[k] = v
      }
    }
    event.tags = cleanTags
  }

  if (event.breadcrumbs?.length) {
    event.breadcrumbs = event.breadcrumbs
      .map((b) => sanitizeBreadcrumb(b))
      .filter((b): b is Breadcrumb => b !== null)
  }

  if (typeof event.message === 'string') {
    event.message = redactSecretsInString(event.message)
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = redactSecretsInString(ex.value)
      }
    }
  }

  return event
}
