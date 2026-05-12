/**
 * Politique de redaction Pino (PRD-004 Ticket 4.1 — Build A2).
 *
 * Source de vérité : `docs/adr/ADR-016-logging-redaction-strategy.md` §2.2.
 *
 * Les chemins listés ici sont passés à `pino` via `pinoHttp.redact.paths`.
 * Syntaxe officielle Pino :
 *   - `req.headers.authorization`   → match exact
 *   - `*.password`                  → match toute clé `password` à toute profondeur
 *   - `*.users[*].email`            → array wildcard
 *
 * Pino tronque automatiquement à `[REDACTED]` (cf. `censor` côté config).
 *
 * ⚠️ Toute nouvelle clé sensible doit être ajoutée ici **avant** d'être
 * autorisée à transiter dans les logs en prod (RGPD + sécurité). Tests
 * snapshot dans `redaction.spec.ts` garantissent la couverture.
 */

/**
 * Classe A — Secrets, tokens, signatures, mots de passe (interdiction
 * absolue de log même tronqué). Toute fuite ici = incident sécurité majeur.
 */
const CLASS_A_PATHS: readonly string[] = Object.freeze([
  // HTTP headers — Authorization + cookies + signatures + clés API + idempotence
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'req.headers["idempotency-key"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  // Bodies — credentials, tokens, secrets
  'req.body.password',
  'req.body.passwordHash',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.sessionToken',
  'req.body.token',
  // Wildcards — passwords / tokens / secrets / signatures partout
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.passwordDigest',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.sessionToken',
  '*.session_token',
  '*.tokenHash',
  '*.token_hash',
  '*.tokenDigest',
  '*.clientSecret',
  '*.client_secret',
  '*.api_secret',
  '*.apiSecret',
  '*.webhook_secret',
  '*.webhookSecret',
  '*.signature',
  '*.cloudinaryParams.signature',
  '*.cloudinaryParams.api_key',
])

/**
 * Classe B — Données financières (numéros carte, comptes bancaires,
 * méthodes Stripe). Couvre la PCI scope.
 */
const CLASS_B_PATHS: readonly string[] = Object.freeze([
  '*.cardNumber',
  '*.card_number',
  '*.card.number',
  '*.card.cvc',
  '*.card.cvv',
  '*.cvv',
  '*.cvc',
  '*.payment_method',
  '*.paymentMethod',
  '*.paymentMethodData',
  '*.bankAccount',
  '*.bank_account',
  '*.iban',
  '*.bic',
  '*.sourceAccount',
  '*.destinationAccount',
])

/**
 * Classe C — PII directe (RGPD) + données métier protégées (adresse exacte,
 * GPS, captureClientUuid = clé d'idempotence privée).
 *
 * Note : `userId` / `missionId` / `paymentId` (UUID) sont **autorisés** —
 * ce sont les pseudonymes CNIL (ADR-016 §3 RGPD).
 */
const CLASS_C_PATHS: readonly string[] = Object.freeze([
  // Identité directe
  '*.email',
  '*.userEmail',
  '*.user_email',
  '*.phone',
  '*.phoneNumber',
  '*.phone_number',
  '*.firstName',
  '*.first_name',
  '*.lastName',
  '*.last_name',
  // Adresse — précision exacte interdite avant ACCEPT (PRD-002)
  '*.street',
  '*.addressLine',
  '*.address_line',
  '*.postalCode',
  '*.postal_code',
  '*.zipCode',
  '*.zip_code',
  '*.address.street',
  '*.address.postalCode',
  // Géolocalisation
  '*.gps',
  '*.coords',
  '*.geolocation',
  '*.location.lat',
  '*.location.lng',
  '*.gpsLat',
  '*.gpsLng',
  '*.latitude',
  '*.longitude',
  // PRD-003 — clé d'idempotence privée + cloudinary upload session
  '*.captureClientUuid',
  '*.capture_client_uuid',
  // IP cliente — donnée à caractère personnel (CNIL)
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
  'req.ip',
  'req.ips',
])

/**
 * Liste finale (figée) injectée dans `pinoHttp.redact.paths`.
 * Ordre : A → B → C (priorité visuelle pour la review).
 */
export const REDACTION_PATHS: readonly string[] = Object.freeze([
  ...CLASS_A_PATHS,
  ...CLASS_B_PATHS,
  ...CLASS_C_PATHS,
])

export const REDACTION_CENSOR = '[REDACTED]'

/**
 * Exposé pour tests snapshot — garantit qu'aucune réorganisation des
 * classes ne fait disparaître silencieusement un chemin.
 */
export const REDACTION_CLASSES = Object.freeze({
  A: CLASS_A_PATHS,
  B: CLASS_B_PATHS,
  C: CLASS_C_PATHS,
})
