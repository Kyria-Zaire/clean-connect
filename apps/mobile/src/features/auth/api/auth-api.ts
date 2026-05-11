/**
 * Client HTTP du module Auth — mobile.
 *
 * Contraintes :
 *  - Le refresh token n'apparaît jamais dans les logs ni les messages d'erreur.
 *  - Toute erreur HTTP est mappée vers `AuthApiError` typé (cf. `auth-errors.ts`).
 *  - Pas de parsing manuel du JWT côté mobile (CTO Ticket 1.4 #1) — le profil
 *    est toujours rechargé via `/auth/me`.
 *
 * NB : on n'utilise PAS d'intercepteur global ici. La logique « refresh-on-401 »
 * vit dans le store (`runWithRefresh`) — c'est le seul endroit qui doit accéder
 * au refresh token en mémoire.
 */

import Constants from 'expo-constants'

import type {
  AuthLoginRequestBody,
  AuthMeResponse,
  AuthRefreshResponse,
  AuthSessionResponse,
  AuthSignUpRequestBody,
} from '../types/auth.types'

import { AuthApiError, mapHttpFailure } from './auth-errors'

const DEFAULT_BASE = 'http://localhost:3000/api/v1'

function getBaseUrl(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { apiBaseUrl?: string }
  const envUrl = process.env['EXPO_PUBLIC_API_URL']
  return extra.apiBaseUrl ?? envUrl ?? DEFAULT_BASE
}

interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  accessToken?: string
}

async function request<T>(opts: RequestOptions): Promise<T> {
  const url = `${getBaseUrl().replace(/\/$/u, '')}${opts.path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (opts.accessToken) {
    headers.Authorization = `Bearer ${opts.accessToken}`
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch {
    throw new AuthApiError('NETWORK_ERROR')
  }

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const parsed = text ? safeJson(text) : null

  if (!response.ok) {
    throw mapHttpFailure(response.status, parsed)
  }

  return (parsed ?? {}) as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const authApi = {
  async signup(body: AuthSignUpRequestBody): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>({ method: 'POST', path: '/auth/signup', body })
  },

  async login(body: AuthLoginRequestBody): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>({ method: 'POST', path: '/auth/login', body })
  },

  async refresh(refreshToken: string): Promise<AuthRefreshResponse> {
    return request<AuthRefreshResponse>({
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken },
    })
  },

  async logout(refreshToken: string): Promise<void> {
    await request<void>({ method: 'POST', path: '/auth/logout', body: { refreshToken } })
  },

  async me(accessToken: string): Promise<AuthMeResponse> {
    return request<AuthMeResponse>({ method: 'GET', path: '/auth/me', accessToken })
  },
}

export { AuthApiError }
