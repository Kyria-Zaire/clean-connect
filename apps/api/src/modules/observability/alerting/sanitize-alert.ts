// PRD-004 Ticket 4.1 (Build B) - sanitization specifique alerts.
//
// Composition des outils deja audites :
//  1. deepSanitize (key-based, classes A/B/C - common/security/sanitize.ts)
//  2. redactSecretsInString (value-based regex - Bearer / sk_ / whsec_ / JWT)
//
// Bornes (cf. ADR-017) :
//  - title max 96 chars
//  - description max 1024 chars
//  - context : 12 cles top-level max, valeurs deep-sanitized

import { deepSanitize, redactSecretsInString } from '../../../common/security/sanitize'

import type { AlertPayload } from './alerting.types'

const MAX_TITLE = 96
const MAX_DESCRIPTION = 1024
const MAX_CONTEXT_KEYS = 12

export function sanitizeForAlert(input: AlertPayload): AlertPayload {
  const title = redactSecretsInString(input.title).slice(0, MAX_TITLE)
  const description =
    input.description === undefined
      ? undefined
      : redactSecretsInString(input.description).slice(0, MAX_DESCRIPTION)

  const context = input.context === undefined ? undefined : sanitizeContext(input.context)

  return {
    severity: input.severity,
    kind: input.kind,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(context !== undefined ? { context } : {}),
  }
}

function sanitizeContext(raw: Record<string, unknown>): Record<string, unknown> {
  // 1. deepSanitize sur l'objet entier : redact key-based (Class A/B/C) sur tout le sous-arbre.
  const deep = deepSanitize(raw) as Record<string, unknown>
  // 2. Cap a 12 cles top-level (anti-spam Discord embed).
  const entries = Object.entries(deep).slice(0, MAX_CONTEXT_KEYS)
  // 3. Pour chaque valeur string, applique en plus redactSecretsInString
  //    (Bearer/sk_/whsec_/JWT inline qui ne matchent aucune cle sensible).
  const sanitized: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    sanitized[k] = typeof v === 'string' ? redactSecretsInString(v) : v
  }
  return sanitized
}
