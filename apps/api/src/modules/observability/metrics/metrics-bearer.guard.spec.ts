/**
 * Tests unitaires MetricsBearerGuard + normalizeRoute + normalizeReason
 * (PRD-004 Ticket 4.1 — Build A3).
 */

import type { ExecutionContext } from '@nestjs/common'

import { normalizeReason } from './bullmq-metrics.service'
import { MetricsBearerGuard } from './metrics-bearer.guard'
import { normalizeRoute } from './route-normalizer'

// Mock loadEnv pour ne pas exiger tout l'environnement applicatif dans
// les tests unitaires du guard — seules METRICS_ENABLED + METRICS_BEARER_TOKEN
// sont pertinents ici. L'état mutable `__mockState` est exposé pour ajuster
// la config entre chaque cas.
const mockEnvState: { enabled: boolean; token: string | undefined } = {
  enabled: true,
  token: undefined,
}

jest.mock('../../../common/config/env', () => ({
  loadEnv: (): { METRICS_ENABLED: boolean; METRICS_BEARER_TOKEN: string | undefined } => ({
    METRICS_ENABLED: mockEnvState.enabled,
    METRICS_BEARER_TOKEN: mockEnvState.token,
  }),
}))

interface BuildContextOpts {
  authHeader?: string
}

function buildContext({ authHeader }: BuildContextOpts): ExecutionContext {
  const req = {
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'authorization' ? authHeader : undefined,
  }
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getType: () => 'http' as const,
    // Stubs non utilisés par le guard mais requis par le type.
    getClass: () => ({}) as never,
    getHandler: () => (() => undefined) as never,
    getArgs: () => [] as never,
    getArgByIndex: () => undefined as never,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext
}

describe('MetricsBearerGuard', () => {
  const TOKEN = 'a'.repeat(48)

  beforeEach(() => {
    mockEnvState.enabled = true
    mockEnvState.token = TOKEN
  })

  it('allows request when Bearer matches the configured token', () => {
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: `Bearer ${TOKEN}` })
    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('denies request when token differs (constant-time)', () => {
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: `Bearer ${'b'.repeat(48)}` })
    expect(guard.canActivate(ctx)).toBe(false)
  })

  it('denies request when scheme is not Bearer', () => {
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: `Basic ${TOKEN}` })
    expect(guard.canActivate(ctx)).toBe(false)
  })

  it('denies request when Authorization header is absent', () => {
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({})
    expect(guard.canActivate(ctx)).toBe(false)
  })

  it('denies request when METRICS_BEARER_TOKEN is not configured', () => {
    mockEnvState.token = undefined
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: `Bearer ${TOKEN}` })
    expect(guard.canActivate(ctx)).toBe(false)
  })

  it('denies request when METRICS_ENABLED is false', () => {
    mockEnvState.enabled = false
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: `Bearer ${TOKEN}` })
    expect(guard.canActivate(ctx)).toBe(false)
  })

  it('denies short tokens (constant-time still safe vs varying length)', () => {
    const guard = new MetricsBearerGuard()
    const ctx = buildContext({ authHeader: 'Bearer short' })
    expect(guard.canActivate(ctx)).toBe(false)
  })
})

describe('normalizeRoute', () => {
  function req(opts: { baseUrl?: string; routePath?: string }) {
    return {
      baseUrl: opts.baseUrl ?? '',
      route: opts.routePath ? { path: opts.routePath } : undefined,
    } as unknown as Parameters<typeof normalizeRoute>[0]
  }

  it('returns baseUrl + route.path when matched', () => {
    expect(normalizeRoute(req({ baseUrl: '/api/v1/users', routePath: '/:id' }))).toBe(
      '/api/v1/users/:id',
    )
  })

  it('falls back to __unmatched__ when route is missing', () => {
    expect(normalizeRoute(req({}))).toBe('__unmatched__')
  })

  it('returns route.path alone when baseUrl is empty', () => {
    expect(normalizeRoute(req({ routePath: '/healthz' }))).toBe('/healthz')
  })

  it('falls back when route.path is empty string', () => {
    expect(normalizeRoute(req({ routePath: '' }))).toBe('__unmatched__')
  })
})

describe('normalizeReason', () => {
  it.each([
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['Job stalled more than maxStalledCount', 'stalled'],
    ['operation timed out after 30s', 'timeout'],
    ['Worker exited with error', 'unknown'],
    ['retries exhausted (5/5)', 'retries_exhausted'],
    ['unhandled rejection in processor', 'unhandled'],
    ['some weird message', 'unknown'],
  ])('normalizeReason(%j) → %s', (input, expected) => {
    expect(normalizeReason(input)).toBe(expected)
  })
})
