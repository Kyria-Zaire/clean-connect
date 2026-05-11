/**
 * authStore — Zustand.
 *
 * Source de vérité côté front pour la session utilisateur :
 *   - `status` : machine à 3 états (`restoring` / `authenticated` / `unauthenticated`).
 *   - `user`   : profil rechargé depuis `/auth/me` (jamais décodé du JWT — CTO Ticket 1.4 #1).
 *   - `tokens` : access + refresh — stockés en mémoire ET persistés dans `expo-secure-store`.
 *   - `pending`/`lastError` : pour piloter loaders & messages UI.
 *
 * Toute la logique de rotation des tokens (refresh-on-401) est encapsulée ici
 * via `runWithAuth` afin que l'app n'ait jamais besoin d'accéder directement
 * au refresh token.
 */

import type { AuthMeResponse } from '@cc/shared-types'
import { create } from 'zustand'

import { authApi, AuthApiError } from '../api/auth-api'
import { clearTokens, readTokens, saveTokens } from '../storage/secure-token-storage'
import type {
  AuthLoginRequestBody,
  AuthPendingFlags,
  AuthSignUpRequestBody,
  AuthStatus,
  AuthUiError,
} from '../types/auth.types'

interface AuthState {
  status: AuthStatus
  user: AuthMeResponse | null
  pending: AuthPendingFlags
  lastError: AuthUiError | null

  bootstrap: () => Promise<void>
  login: (input: AuthLoginRequestBody) => Promise<boolean>
  signup: (input: AuthSignUpRequestBody) => Promise<boolean>
  logout: () => Promise<void>
  clearError: () => void

  /** Exécute un appel authentifié avec refresh automatique sur 401. */
  runWithAuth: <T>(
    call: (accessToken: string) => Promise<T>,
  ) => Promise<{ ok: true; data: T } | { ok: false; error: AuthUiError }>
}

interface TokenSnapshot {
  accessToken: string
  refreshToken: string
}

let tokensInMemory: TokenSnapshot | null = null
let refreshSingleFlight: Promise<TokenSnapshot | null> | null = null

const INITIAL_PENDING: AuthPendingFlags = { login: false, signup: false, logout: false }

export const useAuthStore = create<AuthState>((set) => ({
  status: 'restoring',
  user: null,
  pending: INITIAL_PENDING,
  lastError: null,

  async bootstrap() {
    set({ status: 'restoring', lastError: null })
    const persisted = await readTokens()
    if (!persisted) {
      tokensInMemory = null
      set({ status: 'unauthenticated', user: null })
      return
    }
    tokensInMemory = persisted

    try {
      const me = await authApi.me(persisted.accessToken)
      set({ status: 'authenticated', user: me, lastError: null })
      return
    } catch (err) {
      if (!(err instanceof AuthApiError) || err.code !== 'INVALID_CREDENTIALS') {
        // Erreur réseau / serveur : on garde les tokens, on remet à unauthenticated
        // pour éviter de se retrouver bloqué sur l'écran restoring.
        set({ status: 'unauthenticated', user: null })
        return
      }
    }

    // Access invalide → on tente un refresh silencieux (CTO Ticket 1.4 #6).
    const rotated = await tryRefresh()
    if (!rotated) {
      await silentSignOut()
      set({ status: 'unauthenticated', user: null })
      return
    }
    try {
      const me = await authApi.me(rotated.accessToken)
      set({ status: 'authenticated', user: me, lastError: null })
    } catch {
      await silentSignOut()
      set({ status: 'unauthenticated', user: null })
    }
  },

  async login(input) {
    set((s) => ({ pending: { ...s.pending, login: true }, lastError: null }))
    try {
      const session = await authApi.login(input)
      await persistSession(session.accessToken, session.refreshToken)
      // CTO Ticket 1.4 #1 : profil rechargé depuis /auth/me (jamais via JWT decode).
      const me = await authApi.me(session.accessToken)
      set({ status: 'authenticated', user: me })
      return true
    } catch (err) {
      set({ lastError: toUiError(err) })
      return false
    } finally {
      set((s) => ({ pending: { ...s.pending, login: false } }))
    }
  },

  async signup(input) {
    set((s) => ({ pending: { ...s.pending, signup: true }, lastError: null }))
    try {
      const session = await authApi.signup(input)
      await persistSession(session.accessToken, session.refreshToken)
      const me = await authApi.me(session.accessToken)
      set({ status: 'authenticated', user: me })
      return true
    } catch (err) {
      set({ lastError: toUiError(err) })
      return false
    } finally {
      set((s) => ({ pending: { ...s.pending, signup: false } }))
    }
  },

  async logout() {
    set((s) => ({ pending: { ...s.pending, logout: true } }))
    const snapshot = tokensInMemory
    try {
      if (snapshot) {
        // Logout serveur idempotent (204 systématique côté API) ; on swallow toute erreur.
        await authApi.logout(snapshot.refreshToken).catch(() => undefined)
      }
    } finally {
      await silentSignOut()
      set({ status: 'unauthenticated', user: null, pending: INITIAL_PENDING, lastError: null })
    }
  },

  clearError() {
    set({ lastError: null })
  },

  async runWithAuth(call) {
    if (!tokensInMemory) {
      return { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Session expirée.' } }
    }
    try {
      const data = await call(tokensInMemory.accessToken)
      return { ok: true, data }
    } catch (err) {
      if (!(err instanceof AuthApiError) || err.code !== 'INVALID_CREDENTIALS') {
        return { ok: false, error: toUiError(err) }
      }
    }
    const rotated = await tryRefresh()
    if (!rotated) {
      await silentSignOut()
      set({ status: 'unauthenticated', user: null })
      return { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Session expirée.' } }
    }
    try {
      const data = await call(rotated.accessToken)
      return { ok: true, data }
    } catch (err) {
      const next = toUiError(err)
      if (next.code === 'INVALID_CREDENTIALS' || next.code === 'SESSION_EXPIRED') {
        await silentSignOut()
        set({ status: 'unauthenticated', user: null })
      }
      return { ok: false, error: next }
    }
  },
}))

async function persistSession(accessToken: string, refreshToken: string): Promise<void> {
  tokensInMemory = { accessToken, refreshToken }
  await saveTokens({ accessToken, refreshToken })
}

async function silentSignOut(): Promise<void> {
  tokensInMemory = null
  await clearTokens()
}

async function tryRefresh(): Promise<TokenSnapshot | null> {
  if (!tokensInMemory) return null
  if (!refreshSingleFlight) {
    const current = tokensInMemory
    refreshSingleFlight = (async () => {
      try {
        const rotated = await authApi.refresh(current.refreshToken)
        const next: TokenSnapshot = {
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
        }
        tokensInMemory = next
        await saveTokens(next)
        return next
      } catch {
        return null
      } finally {
        refreshSingleFlight = null
      }
    })()
  }
  return refreshSingleFlight
}

function toUiError(err: unknown): AuthUiError {
  if (err instanceof AuthApiError) return err.toUiError()
  return { code: 'UNKNOWN', message: 'Une erreur est survenue, réessayez.' }
}

/**
 * Helpers exposés pour les tests / dev tools — NE PAS utiliser en code applicatif.
 */
export const __authStoreInternals = {
  readMemoryTokens: (): TokenSnapshot | null => tokensInMemory,
  resetForTests: (): void => {
    tokensInMemory = null
    refreshSingleFlight = null
    useAuthStore.setState({
      status: 'unauthenticated',
      user: null,
      pending: INITIAL_PENDING,
      lastError: null,
    })
  },
}
