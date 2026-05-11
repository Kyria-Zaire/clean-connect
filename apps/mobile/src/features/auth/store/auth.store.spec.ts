/**
 * @jest-environment node
 *
 * Tests unitaires authStore (Zustand) — Mobile PRD-001 Ticket 1.4.
 *
 * Tout ce qui touche `expo-secure-store` est mocké : c'est un module natif
 * non importable en environnement Node.
 */

jest.mock('expo-secure-store', () => {
  const mem = new Map<string, string>()
  return {
    WHEN_UNLOCKED: 'WHEN_UNLOCKED',
    setItemAsync: jest.fn(async (key: string, value: string) => {
      mem.set(key, value)
    }),
    getItemAsync: jest.fn(async (key: string) => mem.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      mem.delete(key)
    }),
    __mem: mem,
  }
})

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }))

// On stub le module API entier — chaque test règle ses propres mocks.
// On évite `requireActual` (importe le vrai expo-constants en ESM) en
// référençant la classe `AuthApiError` depuis le module `auth-errors`.
jest.mock('../api/auth-api', () => {
  const errors = jest.requireActual('../api/auth-errors') as { AuthApiError: unknown }
  return {
    AuthApiError: errors.AuthApiError,
    authApi: {
      signup: jest.fn(),
      login: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
      me: jest.fn(),
    },
  }
})

import * as SecureStore from 'expo-secure-store'

import { authApi } from '../api/auth-api'
import { AuthApiError } from '../api/auth-errors'

import { __authStoreInternals, useAuthStore } from './auth.store'

const mockedApi = authApi as jest.Mocked<typeof authApi>

const baseUser = {
  id: 'u-1',
  email: 'alice@example.com',
  role: 'CLIENT' as const,
  firstName: 'Alice',
  lastName: 'Dupont',
  createdAt: new Date('2026-05-12T10:00:00.000Z').toISOString(),
}

beforeEach(async () => {
  jest.clearAllMocks()
  // Le mock conserve une Map en mémoire entre les tests — on la vide.
  const mocked = SecureStore as unknown as { __mem: Map<string, string> }
  mocked.__mem.clear()
  __authStoreInternals.resetForTests()
})

describe('authStore.login', () => {
  it('persiste les tokens et recharge le profil via /auth/me', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    mockedApi.me.mockResolvedValue(baseUser)

    const ok = await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    expect(ok).toBe(true)
    expect(mockedApi.me).toHaveBeenCalledWith('access-1')
    const state = useAuthStore.getState()
    expect(state.status).toBe('authenticated')
    expect(state.user?.id).toBe('u-1')
    expect(state.lastError).toBeNull()
    expect(__authStoreInternals.readMemoryTokens()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
  })

  it('renvoie false + lastError sur credentials invalides', async () => {
    mockedApi.login.mockRejectedValue(new AuthApiError('INVALID_CREDENTIALS', 401))

    const ok = await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'wrong' })

    expect(ok).toBe(false)
    const state = useAuthStore.getState()
    expect(state.status).toBe('unauthenticated')
    expect(state.lastError?.code).toBe('INVALID_CREDENTIALS')
    expect(state.pending.login).toBe(false)
  })

  it('expose le code NETWORK_ERROR sur défaillance réseau', async () => {
    mockedApi.login.mockRejectedValue(new AuthApiError('NETWORK_ERROR'))
    await useAuthStore.getState().login({ email: 'alice@example.com', password: 'x' })
    expect(useAuthStore.getState().lastError?.code).toBe('NETWORK_ERROR')
  })
})

describe('authStore.signup', () => {
  it('inscrit puis hydrate via /auth/me', async () => {
    mockedApi.signup.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    })
    mockedApi.me.mockResolvedValue(baseUser)

    const ok = await useAuthStore.getState().signup({
      email: 'alice@example.com',
      password: 'Sup3rSecret_passw0rd!',
      role: 'CLIENT',
      firstName: 'Alice',
      lastName: 'Dupont',
    })

    expect(ok).toBe(true)
    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('expose EMAIL_ALREADY_USED sur 409', async () => {
    mockedApi.signup.mockRejectedValue(new AuthApiError('EMAIL_ALREADY_USED', 409))
    const ok = await useAuthStore.getState().signup({
      email: 'taken@example.com',
      password: 'Sup3rSecret_passw0rd!',
      role: 'CLIENT',
      firstName: 'A',
      lastName: 'B',
    })
    expect(ok).toBe(false)
    expect(useAuthStore.getState().lastError?.code).toBe('EMAIL_ALREADY_USED')
  })
})

describe('authStore.bootstrap', () => {
  it('reste unauthenticated si pas de tokens persistés', async () => {
    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(mockedApi.me).not.toHaveBeenCalled()
  })

  it('passe authenticated quand /auth/me répond OK', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    // Reset du status uniquement (tokens conservés en SecureStore via le mock)
    useAuthStore.setState({ status: 'unauthenticated', user: null })

    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().status).toBe('authenticated')
    expect(useAuthStore.getState().user?.email).toBe('alice@example.com')
  })

  it('logout silencieux si refresh invalide', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'expired-access',
      refreshToken: 'invalid-refresh',
    })
    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    useAuthStore.setState({ status: 'unauthenticated', user: null })

    // /auth/me retourne 401 → on tente refresh → refresh échoue → silent signout.
    mockedApi.me.mockRejectedValueOnce(new AuthApiError('INVALID_CREDENTIALS', 401))
    mockedApi.refresh.mockRejectedValueOnce(new AuthApiError('INVALID_REFRESH_TOKEN', 401))

    await useAuthStore.getState().bootstrap()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(__authStoreInternals.readMemoryTokens()).toBeNull()
  })
})

describe('authStore.runWithAuth', () => {
  it('relance le call après rotation refresh sur 401', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    mockedApi.refresh.mockResolvedValueOnce({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    })

    const call = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new AuthApiError('INVALID_CREDENTIALS', 401))
      .mockResolvedValueOnce('ok-2nd-try')

    const out = await useAuthStore.getState().runWithAuth(call)
    expect(out).toEqual({ ok: true, data: 'ok-2nd-try' })
    expect(call).toHaveBeenNthCalledWith(1, 'access-1')
    expect(call).toHaveBeenNthCalledWith(2, 'access-2')
  })

  it('logout silencieux si le refresh échoue', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    mockedApi.refresh.mockRejectedValueOnce(new AuthApiError('INVALID_REFRESH_TOKEN', 401))

    const call = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new AuthApiError('INVALID_CREDENTIALS', 401))

    const out = await useAuthStore.getState().runWithAuth(call)
    expect(out.ok).toBe(false)
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(__authStoreInternals.readMemoryTokens()).toBeNull()
  })
})

describe('authStore.logout', () => {
  it('vide la session même si l\'appel API échoue (idempotent côté UI)', async () => {
    mockedApi.login.mockResolvedValue({
      user: baseUser,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    })
    mockedApi.me.mockResolvedValueOnce(baseUser)
    await useAuthStore
      .getState()
      .login({ email: 'alice@example.com', password: 'Sup3rSecret_passw0rd!' })

    mockedApi.logout.mockRejectedValueOnce(new AuthApiError('NETWORK_ERROR'))
    await useAuthStore.getState().logout()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(__authStoreInternals.readMemoryTokens()).toBeNull()
  })
})
