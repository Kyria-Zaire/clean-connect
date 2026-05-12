/**
 * Formatter Pino — sanitization profonde (PRD-004 Ticket 4.1 — Build A2).
 *
 * Branché dans `LoggerModule` côté `app.module.ts` via `formatters.log`.
 * Appelé pour CHAQUE événement de log avant sérialisation JSON.
 *
 * Pourquoi un formatter dédié et pas `redact.paths` seul ?
 * - `fast-redact` (sous-jacent à Pino) ne supporte **pas** les wildcards
 *   profonds : `*.password` ne matche qu'au premier niveau, pas à `a.b.c.password`.
 * - Notre `deepSanitize` (`common/security/sanitize.ts`) traverse récursivement
 *   à profondeur arbitraire (capée à 8) avec détection de cycles et anti-DoS.
 * - `redact.paths` reste utile pour les chemins HTTP standardisés (headers /
 *   ip) que Pino redacte plus vite côté hot path.
 *
 * Combinaison : `redact.paths` (rapide, premiers niveaux) + `formatters.log`
 * (profondeur arbitraire). Aucun risque de double-redaction visible — une
 * chaîne `[REDACTED]` reste `[REDACTED]`.
 */

import { deepSanitize } from '../security/sanitize'

/**
 * Sanitize un objet de log avant émission. Pino passe l'objet déjà merged
 * (bindings + payload de l'appel). On exclut quelques champs réservés Pino
 * pour ne pas mangler la mécanique interne :
 * - `level`, `time`, `pid`, `hostname` : champs scalaires inertes
 * - `msg` : chaîne déjà passée par `redactSecretsInString` upstream si besoin
 *   (côté Sentry beforeSend). En logs Pino, `msg` reste tel quel.
 */
export function pinoLogFormatter(obj: Record<string, unknown>): Record<string, unknown> {
  return deepSanitize(obj)
}
