/**
 * Constantes d'authentification — partagées entre service, strategy et guards.
 */

import type { AuthErrorCode } from '@cc/shared-types'

export const ROLES_METADATA_KEY = 'cc.auth.roles'
export const IS_PUBLIC_METADATA_KEY = 'cc.auth.isPublic'

export const JWT_ACCESS_STRATEGY_NAME = 'jwt-access'

/** Codes erreur structurés exposés côté API (cf. `authErrorCodeSchema`). */
export const AUTH_ERROR_CODES: Record<AuthErrorCode, AuthErrorCode> = {
  EMAIL_ALREADY_USED: 'EMAIL_ALREADY_USED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ADMIN_SIGNUP_FORBIDDEN: 'ADMIN_SIGNUP_FORBIDDEN',
}
