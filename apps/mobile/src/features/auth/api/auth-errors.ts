import type { AuthErrorCode } from '@cc/shared-types'

import type { AuthUiError, AuthUiErrorCode } from '../types/auth.types'

const SERVER_ERROR_CODES: ReadonlyArray<AuthErrorCode> = [
  'EMAIL_ALREADY_USED',
  'INVALID_CREDENTIALS',
  'INVALID_REFRESH_TOKEN',
  'WEAK_PASSWORD',
  'ADMIN_SIGNUP_FORBIDDEN',
]

/** Messages utilisateur — courts, neutres, exploitables par l'UI. */
const UI_MESSAGES: Record<AuthUiErrorCode, string> = {
  EMAIL_ALREADY_USED: 'Cet email est déjà utilisé.',
  INVALID_CREDENTIALS: 'Email ou mot de passe incorrect.',
  INVALID_REFRESH_TOKEN: 'Session expirée, reconnectez-vous.',
  WEAK_PASSWORD: 'Mot de passe trop faible ou trop commun.',
  ADMIN_SIGNUP_FORBIDDEN: 'Création de compte admin non autorisée.',
  NETWORK_ERROR: 'Connexion impossible — vérifiez votre réseau.',
  SESSION_EXPIRED: 'Session expirée, reconnectez-vous.',
  RATE_LIMITED: 'Trop de tentatives, réessayez dans 1 minute.',
  VALIDATION_ERROR: 'Données invalides — vérifiez les champs.',
  UNKNOWN: 'Une erreur est survenue, réessayez.',
}

export class AuthApiError extends Error {
  public readonly code: AuthUiErrorCode
  public readonly status: number | null

  constructor(code: AuthUiErrorCode, status: number | null = null) {
    super(UI_MESSAGES[code])
    this.name = 'AuthApiError'
    this.code = code
    this.status = status
  }

  toUiError(): AuthUiError {
    return { code: this.code, message: this.message }
  }
}

/**
 * Mappe une réponse HTTP non-2xx vers une `AuthApiError` typée.
 * On ne renvoie JAMAIS le body brut : on ne veut pas leaker de détails techniques
 * (CTO Build #3 — pas de stack, pas de message technique).
 */
export function mapHttpFailure(status: number, body: unknown): AuthApiError {
  if (status === 429) {
    return new AuthApiError('RATE_LIMITED', status)
  }
  if (status >= 500) {
    return new AuthApiError('UNKNOWN', status)
  }
  const code = extractCode(body)
  if (code && SERVER_ERROR_CODES.includes(code)) {
    return new AuthApiError(code, status)
  }
  if (status === 401) {
    return new AuthApiError('INVALID_CREDENTIALS', status)
  }
  if (status === 400) {
    return new AuthApiError('VALIDATION_ERROR', status)
  }
  return new AuthApiError('UNKNOWN', status)
}

function extractCode(body: unknown): AuthErrorCode | null {
  if (body === null || typeof body !== 'object') return null
  const errorField = (body as { error?: unknown }).error
  if (typeof errorField !== 'string') return null
  return SERVER_ERROR_CODES.find((c) => c === errorField) ?? null
}
