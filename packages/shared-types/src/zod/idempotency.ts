/**
 * Idempotency-Key partagé — PRD-003 Design (livrable 2/5 Zod).
 *
 * Décisions CTO :
 *   - Min 8 / Max 255 caractères (Stripe accepte jusqu'à 255).
 *   - Charset contrôlé : `[A-Za-z0-9_-]` (ASCII safe, log-safe, URL-safe).
 *   - **Trim interdit** : la clé doit être consommée *telle quelle* (sinon
 *     deux clés "  abc " et "abc" deviendraient équivalentes, brisant l'idempotence).
 *   - Format stable : utilisé tel quel comme entrée d'index DB et de header Stripe.
 *
 * Utilisations :
 *   - Header `Idempotency-Key` exigé sur toutes les routes mutantes Stripe-bound
 *     (`POST /payments/intents`, `POST /missions/:id/validate`, `POST /photos/sign`...).
 *   - Idempotence DB : `transfers.idempotency_key`, `auto_release_jobs.idempotency_key`.
 *   - Idempotence Stripe API : champ `idempotencyKey` passé à toutes les mutations.
 *
 * Anti-patterns interdits :
 *   - `.trim()` : casse l'idempotence (CTO).
 *   - `.toLowerCase()` : casse la stabilité (CTO).
 *   - Caractères Unicode arbitraires (CTO charset contrôlé).
 *   - Pré-fixe optionnel obligatoire serveur (la clé client est *opaque*).
 */

import { z } from 'zod'

/** Charset autorisé : alphanumérique + `_` + `-` (ASCII printable safe). */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]+$/u

/** Schéma de validation pour un header `Idempotency-Key` côté API. */
export const idempotencyKeySchema = z
  .string({
    required_error: 'Idempotency-Key requis.',
    invalid_type_error: 'Idempotency-Key doit être une chaîne.',
  })
  .min(8, 'Idempotency-Key : minimum 8 caractères.')
  .max(255, 'Idempotency-Key : maximum 255 caractères.')
  .regex(IDEMPOTENCY_KEY_REGEX, 'Idempotency-Key : charset autorisé `[A-Za-z0-9_-]`.')
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>

/**
 * Idempotency-Key *serveur* — déterministe, dérivée de l'entité métier (ex.
 * `transfer-mission-{missionId}`). Validée par la même regex mais réservée
 * au code serveur (jamais reçue via header client).
 */
export const serverIdempotencyKeySchema = idempotencyKeySchema.refine(
  (key) =>
    key.startsWith('cc-') ||
    key.startsWith('transfer-') ||
    key.startsWith('capture-') ||
    key.startsWith('refund-') ||
    key.startsWith('auto-release-'),
  {
    message: 'Server idempotency-key doit utiliser un préfixe métier (cc-/transfer-/capture-/refund-/auto-release-).',
  },
)
export type ServerIdempotencyKey = z.infer<typeof serverIdempotencyKeySchema>
