/**
 * PRD-004 Ticket 4.1 (Build B) — unit tests `BullBoardAuthMiddleware`.
 *
 * Couverture :
 *  - aucun header → 401
 *  - Bearer mal formé → 401
 *  - Bearer == INTERNAL_BEARER_TOKEN → 200 (next called)
 *  - Bearer JWT ADMIN valide → 200
 *  - Bearer JWT CLIENT valide → 403 (role insuffisant)
 *  - Bearer JWT invalide → 401
 *  - Comparaison `timingSafeEqual` : token de longueur différente refusé sans crash
 */

import { randomBytes } from 'node:crypto'

import { JwtService } from '@nestjs/jwt'
import { Role } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'

import { __resetEnvCacheForTests } from '../../../common/config/env'

import { BullBoardAuthMiddleware } from './bullboard-auth.middleware'

const ACCESS_SECRET = 'a'.repeat(48)
const INTERNAL_TOKEN = `internal-${randomBytes(16).toString('hex')}` // > 32 chars

function envSetup(): void {
  process.env.NODE_ENV = 'development'
  process.env.APP_ENV = 'development'
  process.env.DATABASE_URL = 'postgresql://u:p@h:5432/db'
  process.env.REDIS_URL = 'redis://r:6379'
  process.env.JWT_ACCESS_SECRET = ACCESS_SECRET
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(48)
  process.env.CORS_ORIGINS = 'http://localhost'
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_'.padEnd(40, 'x')
  process.env.STRIPE_API_VERSION = '2025-02-24.acacia'
  process.env.INTERNAL_BEARER_TOKEN = INTERNAL_TOKEN
  __resetEnvCacheForTests()
}

function buildMiddleware(): BullBoardAuthMiddleware {
  const jwt = new JwtService({})
  return new BullBoardAuthMiddleware(jwt)
}

function buildRes(): {
  res: Response
  status: jest.Mock
  json: jest.Mock
} {
  const json = jest.fn()
  const status = jest.fn().mockImplementation(() => ({ json }))
  return {
    res: { status } as unknown as Response,
    status,
    json,
  }
}

describe('BullBoardAuthMiddleware (PRD-004 Build B)', () => {
  beforeAll(envSetup)
  afterAll(() => {
    delete process.env.INTERNAL_BEARER_TOKEN
    __resetEnvCacheForTests()
  })

  it('returns 401 when no Authorization header', () => {
    const mw = buildMiddleware()
    const { res, status, json } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use({ headers: {}, path: '/api/internal/queues' } as Request, res, next)

    expect(status).toHaveBeenCalledWith(401)
    expect(json).toHaveBeenCalledWith({ error: 'UNAUTHORIZED' })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when Authorization scheme is not Bearer', () => {
    const mw = buildMiddleware()
    const { res, status } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: 'Basic abc' }, path: '/' } as unknown as Request,
      res,
      next,
    )
    expect(status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('grants access with a valid INTERNAL_BEARER_TOKEN (timing-safe)', () => {
    const mw = buildMiddleware()
    const { res, status } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, path: '/' } as unknown as Request,
      res,
      next,
    )

    expect(next).toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('rejects a token of different length without leaking timing info (no crash)', () => {
    const mw = buildMiddleware()
    const { res, status } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: `Bearer ${'a'.repeat(8)}` }, path: '/' } as unknown as Request,
      res,
      next,
    )
    expect(status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('grants access with a valid JWT ADMIN', () => {
    const jwt = new JwtService({})
    const token = jwt.sign({ sub: 'admin-1', role: Role.ADMIN }, { secret: ACCESS_SECRET })
    const mw = new BullBoardAuthMiddleware(jwt)
    const { res, status } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: `Bearer ${token}` }, path: '/' } as unknown as Request,
      res,
      next,
    )
    expect(next).toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('returns 403 when JWT is valid but role is CLIENT', () => {
    const jwt = new JwtService({})
    const token = jwt.sign({ sub: 'client-1', role: Role.CLIENT }, { secret: ACCESS_SECRET })
    const mw = new BullBoardAuthMiddleware(jwt)
    const { res, status, json } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: `Bearer ${token}` }, path: '/' } as unknown as Request,
      res,
      next,
    )
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({ error: 'FORBIDDEN' })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when JWT signature is invalid', () => {
    const jwt = new JwtService({})
    const token = jwt.sign({ sub: 'a', role: Role.ADMIN }, { secret: 'wrong'.repeat(20) })
    const mw = new BullBoardAuthMiddleware(jwt)
    const { res, status } = buildRes()
    const next = jest.fn() as NextFunction

    mw.use(
      { headers: { authorization: `Bearer ${token}` }, path: '/' } as unknown as Request,
      res,
      next,
    )
    expect(status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
