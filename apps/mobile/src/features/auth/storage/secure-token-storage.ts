/**
 * Persistance SECURISÉE des tokens d'auth — `expo-secure-store` UNIQUEMENT.
 *
 * Contraintes CTO Ticket 1.4 :
 *  - Pas de fallback AsyncStorage.
 *  - Aucun log/console contenant un refresh token.
 *  - `getItemAsync` retourne `null` si la clé n'existe pas ; on encapsule pour
 *    fournir une API stable (`get`/`set`/`clear`).
 */

import * as SecureStore from 'expo-secure-store'

const ACCESS_KEY = 'cc.auth.accessToken'
const REFRESH_KEY = 'cc.auth.refreshToken'

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED,
}

export interface PersistedTokens {
  accessToken: string
  refreshToken: string
}

async function setItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, SECURE_OPTIONS)
}

async function getItem(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, SECURE_OPTIONS)
}

async function deleteItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, SECURE_OPTIONS)
}

export async function saveTokens(tokens: PersistedTokens): Promise<void> {
  await setItem(ACCESS_KEY, tokens.accessToken)
  await setItem(REFRESH_KEY, tokens.refreshToken)
}

export async function readTokens(): Promise<PersistedTokens | null> {
  const [accessToken, refreshToken] = await Promise.all([getItem(ACCESS_KEY), getItem(REFRESH_KEY)])
  if (!accessToken || !refreshToken) return null
  return { accessToken, refreshToken }
}

export async function clearTokens(): Promise<void> {
  await Promise.all([deleteItem(ACCESS_KEY), deleteItem(REFRESH_KEY)])
}
