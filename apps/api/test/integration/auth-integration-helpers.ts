/**
 * Utilitaires partagés — tests d'intégration Auth (PRD-001 Ticket 1.5).
 * Aucune assertion ne doit logger accessToken / refreshToken (pas de console.*).
 */

const FORBIDDEN_KEYS = new Set(['passwordhash', 'tokenhash'])

/**
 * Parcourt récursivement un JSON de réponse HTTP et échoue si une clé sensible
 * apparaît (AC sécurité : aucun endpoint ne retourne passwordHash / tokenHash).
 */
export function assertNoLeakedSecrets(value: unknown, path = 'root'): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoLeakedSecrets(v, `${path}[${i}]`))
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
      throw new Error(`Clé sensible interdite dans la réponse : ${path}.${k}`)
    }
    assertNoLeakedSecrets(v, `${path}.${k}`)
  }
}

export const randomTestEmail = (): string =>
  `it-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@cc-test.fr`

/** Mot de passe conforme au schéma Zod (≥12) et hors blocklist. */
export const STRONG_PASSWORD = 'Sup3rSecret_passw0rd_2026!'

/** Mot de passe ≥12 caractères mais présent dans la blocklist (WEAK_PASSWORD). */
export const WEAK_BLOCKLIST_PASSWORD = 'CleanConnect123'
