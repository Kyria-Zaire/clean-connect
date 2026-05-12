/**
 * Helpers de sanitization génériques (PRD-004 Ticket 4.1).
 *
 * Fonctions **pures**, sans dépendance NestJS / Pino / Sentry. Réutilisées par :
 * - Sentry `beforeSend` / `beforeBreadcrumb`  → `modules/observability/sentry/sanitize.ts`
 * - Pino `formatters.log`                     → `common/logger/log-sanitizer.ts`
 *
 * Liste des chemins sensibles : voir `common/logger/redaction.ts` (source de
 * vérité ADR-016). Ici on définit uniquement la mécanique de traversée et
 * les patterns de clés à matcher.
 */

export const REDACTED = '[REDACTED]'

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
  'gps',
  'coords',
  'geolocation',
])

const ALL_SENSITIVE_PATTERNS: readonly string[] = Object.freeze([
  ...CLASS_A_KEY_PATTERNS,
  ...CLASS_B_KEY_PATTERNS,
  ...CLASS_C_KEY_PATTERNS,
])

const SENSITIVE_QUERY_KEYS: readonly string[] = Object.freeze([
  'signature',
  'api_key',
  'token',
  'access_token',
  'refresh_token',
  'session_token',
  'code',
])

const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 100

export function isSensitiveKey(rawKey: string): boolean {
  const k = rawKey.toLowerCase()
  return ALL_SENSITIVE_PATTERNS.some((pattern) => k.includes(pattern))
}

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

export function redactSecretsInString(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk_(test|live)_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\bwhsec_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/g, REDACTED)
}

export function deepSanitize<T>(
  value: T,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet(),
): T {
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
