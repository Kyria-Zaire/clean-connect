/**
 * Types internes du flux d'authentification mobile.
 *
 * Source de vérité contrat API : `@cc/shared-types` (alignée sur PRD-001).
 * Ici on ne réexporte que ce dont l'app mobile a besoin + on définit l'état UI.
 */

import type {
  AuthErrorCode,
  AuthLoginRequestBody,
  AuthMeResponse,
  AuthRefreshResponse,
  AuthSessionResponse,
  AuthSignUpRequestBody,
} from '@cc/shared-types'

export type {
  AuthErrorCode,
  AuthLoginRequestBody,
  AuthMeResponse,
  AuthRefreshResponse,
  AuthSessionResponse,
  AuthSignUpRequestBody,
}

/**
 * Codes d'erreur exploitables par l'UI mobile.
 * On reprend les codes serveur + on ajoute les cas réseau / session expirée.
 */
export type AuthUiErrorCode =
  | AuthErrorCode
  | 'NETWORK_ERROR'
  | 'SESSION_EXPIRED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN'

export interface AuthUiError {
  code: AuthUiErrorCode
  message: string
}

/**
 * État de la session côté mobile — discriminé pour rendre l'UI déterministe.
 *
 * - `restoring` : tokens en cours de rehydration (premier lancement / cold start).
 * - `authenticated` : access + user hydraté via `/auth/me`.
 * - `unauthenticated` : pas de tokens valides.
 */
export type AuthStatus = 'restoring' | 'authenticated' | 'unauthenticated'

/**
 * Statuts d'opération distincts du statut de session (ne le polluent pas).
 */
export interface AuthPendingFlags {
  login: boolean
  signup: boolean
  logout: boolean
}
