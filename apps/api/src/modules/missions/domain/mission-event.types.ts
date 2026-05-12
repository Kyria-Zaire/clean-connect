/**
 * Types & garde-fous payload pour les évènements mission (PRD-002 Build §1 + §4).
 *
 * Contrainte CTO §4 (Build) : aucune adresse complète dans :
 *   - logs
 *   - push notifications
 *   - BullMQ payloads
 *   - erreurs
 *   avant acceptation.
 *
 * Audit Verify CTO §D — étendu : aucun champ sensible (email, téléphone,
 * tokens, JWT, password) dans un payload audit / log / job, à AUCUN moment du
 * lifecycle (même post-acceptation). Les `mission_events` sont stockés en clair
 * en DB et lus par l'admin → ils ne doivent contenir que des métadonnées
 * fonctionnelles (durée, motifs, identifiants opaques).
 *
 * `assertEventPayloadHygiene` est appliqué par `MissionEventService` avant
 * chaque insert d'évènement audit, et reste utilisable par les processors
 * BullMQ pour valider tout payload sortant.
 */

import type { MissionEventType } from '@cc/shared-types'

/**
 * Champs interdits dans tout payload (audit, logs, jobs, erreurs).
 *
 * Catégorisés (avec préfixes possibles) :
 *  - Adresse complète : street*, location, lat/lng, full address, coordonnées
 *  - PII directe     : email*, phone*, mobile*, telephone*
 *  - Secrets / auth  : password*, token*, jwt*, refresh*, accessToken,
 *                      authorization, apiKey, secret*
 */
const FORBIDDEN_KEYS = new Set<string>([
  'street',
  'streetLine1',
  'streetLine2',
  'addressLine1',
  'addressLine2',
  'fullAddress',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'location',
  'geo',
  'coordinates',
  'email',
  'emailAddress',
  'phone',
  'phoneNumber',
  'mobile',
  'telephone',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'jwt',
  'authorization',
  'apiKey',
  'secret',
])

/**
 * Vérifie récursivement qu'un payload n'embarque aucun champ sensible.
 * Lance `Error` si une clé interdite est détectée — bloquant côté service
 * (fail-fast plutôt que de polluer la DB d'audit).
 */
export function assertEventPayloadHygiene(value: unknown, path: string[] = []): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertEventPayloadHygiene(item, [...path, String(idx)]))
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `assertEventPayloadHygiene: champ interdit "${key}" détecté à ${[...path, key].join('.')}`,
      )
    }
    assertEventPayloadHygiene(child, [...path, key])
  }
}

/**
 * Alias rétrocompatible — `assertNoAddressLeak` était l'API du Build initial.
 * Le périmètre a été élargi (audit Verify CTO §D) : la fonction valide
 * désormais l'absence d'adresse ET de PII / secrets.
 */
export const assertNoAddressLeak = assertEventPayloadHygiene

export type MissionEventInput = {
  missionId: string
  type: MissionEventType
  actorUserId: string | null
  payload?: Record<string, unknown> | null
}
