/**
 * RoleGuard — application unique Client + Prestataire (cf. cahier v1.4 §2 + ADR-001).
 *
 * Depuis PRD-001 Ticket 1.4 : le rôle "officiel" de l'utilisateur vient du
 * profil chargé via `/auth/me` (cf. `authStore.user.role`). Cette utilitaire
 * conserve l'idée d'un rôle "actif" pour les futurs comptes multi-rôles
 * (CLIENT + PRESTATAIRE sur un même compte). En MVP, `User.role` est unique,
 * donc l'override stocké est aligné par défaut.
 *
 * TODO(debt): basculer sur MMKV en Phase Pré-MVP (cf. ADR-001).
 */

import type { Role } from '@cc/shared-types'
import AsyncStorage from '@react-native-async-storage/async-storage'

const ACTIVE_ROLE_KEY = 'cc.activeRole'

export type AccountRoles = { client: boolean; prestataire: boolean }

export async function getActiveRole(roles: AccountRoles): Promise<Role> {
  const stored = (await AsyncStorage.getItem(ACTIVE_ROLE_KEY)) as Role | null
  if (stored === 'CLIENT' && roles.client) return 'CLIENT'
  if (stored === 'PRESTATAIRE' && roles.prestataire) return 'PRESTATAIRE'
  return roles.prestataire ? 'PRESTATAIRE' : 'CLIENT'
}

export async function setActiveRole(role: Role): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_ROLE_KEY, role)
}

export async function clearActiveRole(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE_ROLE_KEY)
}

/** Construit `AccountRoles` à partir du rôle unique exposé par le serveur. */
export function rolesFromUserRole(role: Role): AccountRoles {
  return { client: role === 'CLIENT', prestataire: role === 'PRESTATAIRE' }
}
