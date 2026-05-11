/**
 * RoleGuard — application unique Client + Prestataire (cf. cahier v1.4 §2 + ADR-001).
 *
 * Stockage : AsyncStorage en Phase Dev (ADR-001), basculera sur MMKV en Phase Pré-MVP.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Role } from '@cc/shared-types'

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
