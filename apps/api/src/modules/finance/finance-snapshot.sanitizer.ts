/**
 * PRD-004 Ticket 4.5 — `sanitizeForFinanceSnapshot`.
 *
 * Source de vérité : ADR-018 §4.1 + PRD-004 §4.15.7 + pré-revue sécurité
 * `2026-05-12-prd-004-financial-monitoring-design-prereview.md` (Condition #1 :
 * fuzz test obligatoire en CI).
 *
 * Mécanique :
 *  1. **Whitelist explicite** — seuls les champs déclarés dans
 *     `FINANCE_SNAPSHOT_WHITELIST[resourceKind]` sont conservés.
 *  2. **Troncature `stripeId*`** — toute valeur est tronquée à 24 chars
 *     (`stripeIdTruncated` pattern PRD §4.15.7) AVANT d'être réinjectée.
 *  3. **`deepSanitize` final** — second filet pour redact tout pattern PII
 *     (`email`, `phone`, …) qui aurait pu se glisser dans un champ neutre
 *     (defensive coding — un upstream rebuild de Stripe API pourrait
 *     renvoyer un champ libre).
 *
 * **Aucune dépendance NestJS** — fonction pure, testable en unitaire pur,
 * réutilisable côté `AlertingService.sanitizeForAlert` (futur ADR).
 */

import { deepSanitize, redactSecretsInString } from '../../common/security/sanitize'

import {
  FINANCE_SNAPSHOT_WHITELIST,
  FINANCE_STRIPE_ID_TRUNCATE_LENGTH,
} from './finance.constants'

/** `resourceKind` au sens snapshot — clé d'entrée whitelist. */
export type FinanceSnapshotKind = keyof typeof FINANCE_SNAPSHOT_WHITELIST

/** Helper exposé pour les tests + alerting — tronque un Stripe id (`pi_…`, `tr_…`, `re_…`). */
export function truncateStripeId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const trimmed = raw.trim()
  if (trimmed.length <= FINANCE_STRIPE_ID_TRUNCATE_LENGTH) return trimmed
  return `${trimmed.slice(0, FINANCE_STRIPE_ID_TRUNCATE_LENGTH)}…`
}

/**
 * Applique la whitelist + troncature + deepSanitize. Retourne TOUJOURS un
 * objet plat (jamais d'array racine, jamais d'undefined). Les champs
 * `stripeId*` exposés sont systématiquement tronqués via la convention
 * `<field>Truncated` (whitelist embarque déjà la suffixe).
 *
 * **Comportement strict** :
 *  - `null`/`undefined` input ⇒ `{}` (jamais d'exception).
 *  - Tableau racine ⇒ `{}` (refus).
 *  - Champs hors whitelist ⇒ supprimés (pas de log — le test fuzz fait foi).
 *  - `BigInt` / `Date` ⇒ convertis en string ISO (compatible `JSON.stringify`).
 *  - `string` > 256 chars ⇒ tronqué à 256 chars + `[…]` (defense in depth).
 */
export function sanitizeForFinanceSnapshot(
  resourceKind: FinanceSnapshotKind,
  raw: unknown,
): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const whitelist = FINANCE_SNAPSHOT_WHITELIST[resourceKind] as readonly string[]
  if (!whitelist || whitelist.length === 0) return {}

  const input = raw as Record<string, unknown>
  const projected: Record<string, unknown> = {}

  for (const key of whitelist) {
    if (!(key in input)) continue

    let value: unknown = input[key]

    if (key.endsWith('Truncated')) {
      // Convention : <stripeIdField>Truncated → on cherche d'abord la clé
      // sans suffixe puis on tronque. La whitelist peut contenir directement
      // un `stripeIdTruncated` déjà tronqué côté caller — on revalide tout
      // de même.
      const sourceKey = key.slice(0, -'Truncated'.length)
      const sourceVal = input[sourceKey] ?? value
      const truncated = truncateStripeId(sourceVal)
      if (truncated !== null) projected[key] = truncated
      continue
    }

    if (value instanceof Date) {
      value = value.toISOString()
    } else if (typeof value === 'bigint') {
      value = value.toString()
    } else if (typeof value === 'string') {
      let str = value
      if (str.length > 256) str = `${str.slice(0, 256)}[…]`
      value = redactSecretsInString(str)
    }

    projected[key] = value
  }

  // Second filet de sécurité — defensive deepSanitize sur l'objet projeté.
  // Couvre le cas exotique où un champ neutre du whitelist contiendrait
  // un objet imbriqué avec un sous-champ PII (ex. `metadata: { email: '…' }`).
  return deepSanitize(projected)
}
