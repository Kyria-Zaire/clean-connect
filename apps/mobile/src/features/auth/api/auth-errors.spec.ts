/**
 * @jest-environment node
 */

import { AuthApiError, mapHttpFailure } from './auth-errors'

describe('mapHttpFailure', () => {
  it('mappe 401 + INVALID_CREDENTIALS sur la classe AuthApiError', () => {
    const err = mapHttpFailure(401, { error: 'INVALID_CREDENTIALS' })
    expect(err).toBeInstanceOf(AuthApiError)
    expect(err.code).toBe('INVALID_CREDENTIALS')
    expect(err.message).toContain('Email')
  })

  it('mappe 409 + EMAIL_ALREADY_USED', () => {
    const err = mapHttpFailure(409, { error: 'EMAIL_ALREADY_USED' })
    expect(err.code).toBe('EMAIL_ALREADY_USED')
  })

  it('mappe 429 sur RATE_LIMITED quel que soit le body', () => {
    expect(mapHttpFailure(429, null).code).toBe('RATE_LIMITED')
    expect(mapHttpFailure(429, { error: 'whatever' }).code).toBe('RATE_LIMITED')
  })

  it('mappe 400 sans code reconnu sur VALIDATION_ERROR', () => {
    expect(mapHttpFailure(400, { error: 'NOT_A_REAL_CODE' }).code).toBe('VALIDATION_ERROR')
    expect(mapHttpFailure(400, null).code).toBe('VALIDATION_ERROR')
  })

  it('mappe 500 sur UNKNOWN (pas de fuite technique)', () => {
    const err = mapHttpFailure(500, { error: 'PrismaClientKnownRequestError', stack: 'leak' })
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).not.toContain('Prisma')
    expect(err.message).not.toContain('leak')
  })

  it('mappe WEAK_PASSWORD via le code structuré', () => {
    expect(mapHttpFailure(400, { error: 'WEAK_PASSWORD' }).code).toBe('WEAK_PASSWORD')
  })

  it('expose un AuthUiError stable', () => {
    const ui = mapHttpFailure(401, { error: 'INVALID_CREDENTIALS' }).toUiError()
    expect(ui.code).toBe('INVALID_CREDENTIALS')
    expect(typeof ui.message).toBe('string')
  })
})
