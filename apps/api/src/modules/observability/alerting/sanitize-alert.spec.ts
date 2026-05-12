/**
 * PRD-004 Ticket 4.1 (Build B) — unit tests `sanitizeForAlert`.
 *
 * Couverture :
 *  - title tronqué à 96 chars
 *  - description tronquée à 1024 chars
 *  - context : 12 clés top-level max
 *  - clés sensibles (CLASS A/B/C) → [REDACTED]
 *  - secrets inline dans title/description (Bearer / sk_ / whsec_ / JWT) →
 *    remplacés par [REDACTED]
 *  - secrets inline dans context values → remplacés
 *  - severity + kind sont préservés (jamais modifiés)
 */

import type { AlertPayload } from './alerting.types'
import { sanitizeForAlert } from './sanitize-alert'

describe('sanitizeForAlert (PRD-004 Build B)', () => {
  it('preserves severity and kind verbatim', () => {
    const out = sanitizeForAlert({
      severity: 'P0',
      kind: 'webhook_failed_rate',
      title: 'high failure',
    })
    expect(out.severity).toBe('P0')
    expect(out.kind).toBe('webhook_failed_rate')
  })

  it('redacts Bearer tokens inline in title', () => {
    const out = sanitizeForAlert({
      severity: 'P1',
      kind: 'stripe_api_failure_spike',
      title: 'token leaked Bearer abc.def.ghi was used',
    })
    expect(out.title).not.toContain('abc.def.ghi')
    expect(out.title).toContain('Bearer [REDACTED]')
  })

  it('redacts Stripe secret prefixes inline in description', () => {
    const out = sanitizeForAlert({
      severity: 'P0',
      kind: 'dlq_growth',
      title: 'test',
      description: 'api key sk_test_xxxxxxxxxxxx leaked + whsec_yyyyyyyyy too',
    })
    expect(out.description).not.toContain('sk_test_xxxxxxxxxxxx')
    expect(out.description).not.toContain('whsec_yyyyyyyyy')
    expect(out.description).toContain('[REDACTED]')
  })

  it('redacts JWTs inline', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature123'
    const out = sanitizeForAlert({
      severity: 'P1',
      kind: 'bullmq_failed_jobs',
      title: 'job failed',
      description: `header ${jwt} caused crash`,
    })
    expect(out.description).not.toContain(jwt)
  })

  it('truncates title at 96 chars', () => {
    const title = 'A'.repeat(200)
    const out = sanitizeForAlert({ severity: 'P0', kind: 'dlq_growth', title })
    expect(out.title?.length).toBe(96)
  })

  it('truncates description at 1024 chars', () => {
    const description = 'B'.repeat(2000)
    const out = sanitizeForAlert({ severity: 'P0', kind: 'dlq_growth', title: 't', description })
    expect(out.description?.length).toBe(1024)
  })

  it('caps context to 12 top-level keys', () => {
    const context: Record<string, unknown> = {}
    for (let i = 0; i < 30; i += 1) context[`k${i}`] = i
    const out = sanitizeForAlert({
      severity: 'P0',
      kind: 'dlq_growth',
      title: 't',
      context,
    })
    expect(Object.keys(out.context ?? {})).toHaveLength(12)
  })

  it('redacts sensitive keys inside context (deepSanitize)', () => {
    const out = sanitizeForAlert({
      severity: 'P0',
      kind: 'dlq_growth',
      title: 't',
      context: {
        queueSize: 12,
        authorization: 'Bearer leaked',
        password: 'pwd',
        nested: { cookie: 'session=xyz' },
      },
    })
    expect(out.context?.queueSize).toBe(12)
    expect(out.context?.authorization).toBe('[REDACTED]')
    expect(out.context?.password).toBe('[REDACTED]')
    expect((out.context?.nested as Record<string, unknown>).cookie).toBe('[REDACTED]')
  })

  it('redacts secret patterns inside string context values (regex)', () => {
    const out = sanitizeForAlert({
      severity: 'P0',
      kind: 'stripe_api_failure_spike',
      title: 't',
      context: {
        errorMessage: 'rate limited for sk_live_xxxxxxxx — retry later',
      },
    })
    expect(out.context?.errorMessage).not.toContain('sk_live_xxxxxxxx')
    expect(out.context?.errorMessage).toMatch(/\[REDACTED\]/)
  })

  it('handles undefined description + undefined context gracefully', () => {
    const input: AlertPayload = { severity: 'P0', kind: 'dlq_growth', title: 't' }
    const out = sanitizeForAlert(input)
    expect(out.description).toBeUndefined()
    expect(out.context).toBeUndefined()
  })
})
