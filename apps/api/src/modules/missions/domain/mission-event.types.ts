/**
 * Types & garde-fous adresse pour les évènements mission (PRD-002 Build §1 + §4).
 *
 * Contrainte CTO §4 : aucune adresse complète dans :
 *   - logs
 *   - push notifications
 *   - BullMQ payloads
 *   - erreurs
 *   avant acceptation.
 *
 * Le helper `assertNoAddressLeak` est appliqué par `MissionEventService` avant
 * chaque insert d'évènement audit (et utilisable côté processors BullMQ).
 */

import type { MissionEventType } from '@cc/shared-types'

/** Champs interdits dans tout payload (audit, logs, jobs, erreurs avant ACCEPT). */
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
])

/** Throws si le payload (récursif) contient une donnée d'adresse complète. */
export function assertNoAddressLeak(value: unknown, path: string[] = []): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertNoAddressLeak(item, [...path, String(idx)]))
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `assertNoAddressLeak: champ interdit "${key}" détecté à ${[...path, key].join('.')}`,
      )
    }
    assertNoAddressLeak(child, [...path, key])
  }
}

export type MissionEventInput = {
  missionId: string
  type: MissionEventType
  actorUserId: string | null
  payload?: Record<string, unknown> | null
}
