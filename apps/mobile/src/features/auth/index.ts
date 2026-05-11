/**
 * Point d'entrée du feature `auth` — mobile (PRD-001 Ticket 1.4).
 * Structure :
 *   - api/       : client HTTP + mapping erreurs
 *   - storage/   : expo-secure-store
 *   - store/     : Zustand (status, user, pending, lastError, actions)
 *   - hooks/     : useAuthStatus / useAuthUser / useAuthPending / useAuthError / useAuthBootstrap
 *   - screens/   : LoginScreen / SignupScreen
 *   - types/     : types réexportés depuis @cc/shared-types + AuthUiError
 */

export { authApi } from './api/auth-api'
export { AuthApiError } from './api/auth-errors'
export {
  useAuthBootstrap,
  useAuthError,
  useAuthPending,
  useAuthStatus,
  useAuthUser,
} from './hooks'
export { LoginScreen } from './screens/LoginScreen'
export { SignupScreen } from './screens/SignupScreen'
export { useAuthStore } from './store/auth.store'
export type {
  AuthMeResponse,
  AuthStatus,
  AuthUiError,
  AuthUiErrorCode,
} from './types/auth.types'
