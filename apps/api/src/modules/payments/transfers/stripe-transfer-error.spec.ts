import { classifyStripeTransferError } from './stripe-transfer-error'

class FakeStripeError extends Error {
  constructor(
    public readonly type: string,
    public readonly code: string | undefined,
    public readonly statusCode: number | null,
  ) {
    super(`stripe ${type} ${code ?? ''}`)
    this.name = 'StripeError'
  }
}

describe('classifyStripeTransferError', () => {
  describe('permanent codes', () => {
    it.each([
      'account_closed',
      'transfer_already_paid',
      'insufficient_funds_to_be_transferred',
      'parameter_invalid_empty',
      'parameter_invalid_integer',
      'parameter_unknown',
      'account_capabilities_required',
    ])('classifies %s as permanent', (code) => {
      const err = new FakeStripeError('invalid_request_error', code, 400)
      const result = classifyStripeTransferError(err)
      expect(result.kind).toBe('permanent')
      expect(result.code).toBe(code)
      expect(result.statusCode).toBe(400)
    })
  })

  describe('transient types', () => {
    it.each([
      'api_connection_error',
      'api_error',
      'rate_limit_error',
      'idempotency_error',
    ])('classifies %s type as transient', (type) => {
      const err = new FakeStripeError(type, 'unknown', null)
      expect(classifyStripeTransferError(err).kind).toBe('transient')
    })

    it('classifies HTTP 5xx with unknown type as transient', () => {
      const err = new FakeStripeError('invalid_request_error', undefined, 503)
      const result = classifyStripeTransferError(err)
      expect(result.kind).toBe('transient')
      expect(result.code).toBe('http_5xx')
      expect(result.statusCode).toBe(503)
    })
  })

  describe('unknown classification', () => {
    it('returns unknown for non-Stripe Error', () => {
      const err = new Error('generic db error')
      expect(classifyStripeTransferError(err)).toEqual({
        kind: 'unknown',
        code: 'non_stripe_error',
        statusCode: null,
      })
    })

    it('returns unknown for non-Error value', () => {
      expect(classifyStripeTransferError('boom')).toEqual({
        kind: 'unknown',
        code: 'non_stripe_error',
        statusCode: null,
      })
    })

    it('returns unknown for Stripe error type not in transient set and status < 500', () => {
      const err = new FakeStripeError('card_error', 'card_declined', 402)
      expect(classifyStripeTransferError(err)).toEqual({
        kind: 'unknown',
        code: 'card_declined',
        statusCode: 402,
      })
    })
  })

  it('does not leak err.message into the returned shape', () => {
    const err = new FakeStripeError('rate_limit_error', 'rate_limit', 429)
    err.message = 'Long error message with potentially sensitive data 4242424242424242'
    const result = classifyStripeTransferError(err)
    expect(result.kind).toBe('transient')
    expect(JSON.stringify(result)).not.toContain('4242')
  })
})
