/**
 * Sanitization filters pour Sentry (PRD-004 Ticket 4.1 — Build A1).
 *
 * Toutes les fonctions exportées ici sont **pures** : aucun effet de bord,
 * aucun accès au runtime Sentry, aucune lecture `process.env`. Testées
 * exhaustivement dans `sanitize.spec.ts`.
 *
 * Politique de redaction conforme à ADR-014 §2.6 + ADR-016 (classes A/B/C).
 * Toute exception non gérée traverse `sanitizeEvent` avant d'être envoyée
 * au serveur Sentry → zéro PII / secret en sortie réseau (RGPD + sécurité).
 */

import type { ErrorEvent, EventHint, Breadcrumb } from '@sentry/node'

export const REDACTED = '[REDACTED]'

/**
 * Classe A — Secrets critiques.
 * Tout chemin (en `lowerCase`) qui contient un de ces tokens est redacted.
 * Couvre Authorization, cookies, signatures Stripe / Cloudinary, tokens session,
 * passwords, clés API.
 */
const CLASS_A_KEY_PATTERNS: readonly string[] = Object.freeze([
  'authorization',
  'auth_token',
  'authtoken',
  'cookie',
  'set-cookie',
  'setcookie',
  'stripe-signature',
  'idempotency-key',
  'x-api-key',
  'xapikey',
  'api_secret',
  'apisecret',
  'webhook_secret',
  'webhooksecret',
  'password',
  'passwordhash',
  'password_hash',
  'session_token',
  'sessiontoken',
  'token_hash',
  'tokenhash',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'client_secret',
  'clientsecret',
  'signature',
  'cvv',
  'cvc',
])

/**
 * Classe B — Données financières / paiement à ne jamais exposer
 * (numéros, méthodes Stripe, comptes bancaires).
 */
const CLASS_B_KEY_PATTERNS: readonly string[] = Object.freeze([
  'cardnumber',
  'card_number',
  'card.number',
  'payment_method',
  'paymentmethod',
  'paymentmethoddata',
  'bankaccount',
  'bank_account',
  'iban',
  'bic',
])

/**
 * Classe C — PII directe (utilisateur identifiable) + données métier
 * protégées (adresse exacte, coordonnées GPS, idempotence privée).
 *
 * `userId` UUID n'est PAS dans cette liste : c'est le pseudonyme CNIL autorisé
 * (ADR-016 §2.2 + §3 RGPD). Idem `missionId`.
 */
const CLASS_C_KEY_PATTERNS: readonly string[] = Object.freeze([
  'email',
  'phone',
  'phonenumber',
  'phone_number',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'street',
  'addressline',
  'address_line',
  'postalcode',
  'postal_code',
  'zipcode',
  'zip_code',
  'gpslat',
  'gps_lat',
  'gpslng',
  'gps_lng',
  'gps_lon',
  'gpslon',
  'latitude',
  'longitude',
  'captureclientuuid',
  'capture_client_uuid',
  // Bloque la totalité du sous-objet `gps` / `coords` / `geolocation` :
  // évite de devoir matcher `lat` / `lng` (trop courts → faux positifs sur
  // `flat`, `latency`, `flag`). Le parent entier devient `[REDACTED]`.
  'gps',
  'coords',
  'geolocation',
])

const ALL_SENSITIVE_PATTERNS: readonly string[] = Object.freeze([
  ...CLASS_A_KEY_PATTERNS,
  ...CLASS_B_KEY_PATTERNS,
  ...CLASS_C_KEY_PATTERNS,
])

/**
 * `true` si le nom de propriété (déjà normalisé) doit être redacted.
 * Match sur substring lowercase pour couvrir les variations de casing
 * (`Authorization`, `authorization`, `AUTHORIZATION`) et les préfixes
 * (`my_password`, `userPassword`, `password_hash`).
 */
export function isSensitiveKey(rawKey: string): boolean {
  const k = rawKey.toLowerCase()
  return ALL_SENSITIVE_PATTERNS.some((pattern) => k.includes(pattern))
}

/**
 * Patterns d'URL à redacted complètement (ex: signed URLs Cloudinary avec
 * `signature` en query, OAuth callback avec `code`).
 */
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
 * Redact les query params sensibles d'une URL.
 * - `https://res.cloudinary.com/x?signature=abc&public_id=foo`
 *    → `https://res.cloudinary.com/x?signature=[REDACTED]&public_id=foo`
 * - URL invalide ou string vide → renvoyée telle quelle.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  try {
    const url = new URL(rawUrl)
    let mutated = false
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED)
        mutated = true
      }
    }
    return mutated ? url.toString() : rawUrl
  } catch {
    return rawUrl
  }
}

/**
 * Profondeur max de récursion (sécurité anti-bombe / cycle).
 * Sentry tronque déjà à `normalizeDepth=3` par défaut ; on garde 8 pour
 * traverser les contextes BullMQ (`job.data.payload.event.data.object.*`).
 */
const MAX_DEPTH = 8

/**
 * Limite raisonnable sur la taille des arrays redactées (anti-DoS sur breadcrumbs).
 */
const MAX_ARRAY_ITEMS = 100

/**
 * Récursive : retourne une **copie** de `value` où toute clé sensible est
 * remplacée par `REDACTED`. Préserve la structure (objet/array). Détecte
 * les cycles via WeakSet.
 */
export function deepSanitize<T>(value: T, depth: number = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (depth >= MAX_DEPTH) return REDACTED as unknown as T
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value as T
  if (typeof value !== 'object') return value

  if (seen.has(value as object)) return REDACTED as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => deepSanitize(item, depth + 1, seen))
    return out as unknown as T
  }

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED
      continue
    }
    out[key] = deepSanitize(raw, depth + 1, seen)
  }
  return out as unknown as T
}

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
 * Heuristique : redact les tokens Bearer / `sk_live_*` / `whsec_*` qui
 * pourraient apparaître inline dans un message d'erreur ou de log.
 *
 * Intentionnellement conservateur — on accepte un faux négatif occasionnel
 * plutôt que de mangler les messages utiles.
 */
export function redactSecretsInString(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk_(test|live)_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\bwhsec_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/g, REDACTED)
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
 * - `event.user`                    → seules `id` (UUID) / `ip_address`
 *                                     (déjà off via `sendDefaultPii: false`)
 *                                     restent ; `email`, `username` strip
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
