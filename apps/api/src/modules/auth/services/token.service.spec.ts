import { JwtService } from '@nestjs/jwt'

import { TokenService } from './token.service'

describe('TokenService', () => {
  beforeAll(() => {
    process.env['JWT_ACCESS_SECRET'] = 'test_access_secret_min_48_chars_abcdef_abcdef_abcdef_abcdef_xyz'
    process.env['JWT_REFRESH_SECRET'] = 'test_refresh_secret_min_48_chars_xyz_xyz_xyz_xyz_xyz_xyz_xyz_abc'
    process.env['JWT_ACCESS_EXPIRES_IN'] = '15m'
    process.env['JWT_REFRESH_EXPIRES_IN'] = '30d'
    process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5433/cleanconnect_test'
    process.env['REDIS_URL'] = 'redis://localhost:6380'
    process.env['CORS_ORIGINS'] = 'http://localhost:5173'
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_xyz'
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_xyz'
    process.env['NODE_ENV'] = 'development'
    process.env['APP_ENV'] = 'development'
  })

  const buildService = () => new TokenService(new JwtService({}))

  it('issueRefreshToken génère un opaque base64url + son hash sha256 hex 64', () => {
    const svc = buildService()
    const r = svc.issueRefreshToken()
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(r.token).not.toEqual(r.tokenHash)
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('hashRefreshToken est déterministe et distinct du token', () => {
    const svc = buildService()
    const h1 = svc.hashRefreshToken('abc-123-zzzzzzzz')
    const h2 = svc.hashRefreshToken('abc-123-zzzzzzzz')
    expect(h1).toEqual(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('issueAccessToken signe un JWT vérifiable avec le secret access', async () => {
    const svc = buildService()
    const issued = await svc.issueAccessToken({ userId: 'u-1', role: 'CLIENT' })
    expect(typeof issued.token).toBe('string')
    expect(issued.expiresInSeconds).toBeGreaterThan(0)
    const decoded = await svc.verifyAccessToken(issued.token)
    expect(decoded.sub).toEqual('u-1')
    expect(decoded.role).toEqual('CLIENT')
    expect(decoded.jti).toEqual(issued.jti)
  })

  it('verifyAccessToken refuse une signature invalide', async () => {
    const svc = buildService()
    await expect(svc.verifyAccessToken('not.a.valid.jwt')).rejects.toBeDefined()
  })
})
