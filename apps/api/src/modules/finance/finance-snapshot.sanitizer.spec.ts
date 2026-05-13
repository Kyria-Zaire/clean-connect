import { sanitizeForFinanceSnapshot, truncateStripeId } from './finance-snapshot.sanitizer'

describe('sanitizeForFinanceSnapshot', () => {
  it('keeps only whitelisted PAYMENT keys', () => {
    const longPi = `pi_${'a'.repeat(27)}`
    const out = sanitizeForFinanceSnapshot('PAYMENT', {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'CAPTURED',
      amountCapturedCents: 1234,
      email: 'leak@example.com',
      extra: 'nope',
      stripePaymentIntentId: longPi,
      stripePaymentIntentIdTruncated: 'ignored',
    })

    expect(out).toEqual(
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        status: 'CAPTURED',
        amountCapturedCents: 1234,
      }),
    )
    expect(out).not.toHaveProperty('email')
    expect(out).not.toHaveProperty('extra')
    expect(out['stripePaymentIntentIdTruncated']).toBe(`pi_${'a'.repeat(21)}…`)
  })

  it('fuzz: never returns non-whitelisted top-level keys for TRANSFER snapshots', () => {
    const allowed = new Set([
      'id',
      'status',
      'amountCents',
      'currency',
      'retryCount',
      'failureCode',
      'createdAt',
      'updatedAt',
      'stripeTransferIdTruncated',
    ])

    for (let i = 0; i < 200; i += 1) {
      const noise: Record<string, unknown> = {}
      for (let k = 0; k < 12; k += 1) {
        noise[`k_${i}_${k}`] = { nested: { email: 'x@y.fr', token: 'sk_test_abc' } }
      }
      noise.id = '00000000-0000-4000-8000-000000000099'
      noise.status = 'PENDING'
      noise.amountCents = 100
      noise.currency = 'eur'
      noise.retryCount = 0
      noise.createdAt = '2026-05-12T00:00:00.000Z'
      noise.updatedAt = '2026-05-12T00:00:00.000Z'
      noise.stripeTransferId = 'tr_live_1234567890abcdefghijklmnop'

      const out = sanitizeForFinanceSnapshot('TRANSFER', noise)
      for (const key of Object.keys(out)) {
        expect(allowed.has(key)).toBe(true)
      }
      expect(JSON.stringify(out)).not.toMatch(/sk_test_|@/)
    }
  })
})

describe('truncateStripeId', () => {
  it('truncates long ids', () => {
    expect(truncateStripeId('pi_' + 'a'.repeat(80))).toBe(`pi_${'a'.repeat(21)}…`)
  })
})
