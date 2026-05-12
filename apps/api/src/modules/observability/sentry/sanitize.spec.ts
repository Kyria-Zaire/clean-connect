/**
 * Tests unitaires sanitization Sentry (PRD-004 Ticket 4.1 — Build A1).
 *
 * Couverture obligatoire (CTO Build A1) :
 * - secrets headers (Authorization, Cookie, Stripe signature) → REDACTED
 * - bodies (password, refreshToken, sessionToken, captureClientUuid, GPS) → REDACTED
 * - breadcrumbs URL avec signature Cloudinary → query param redacté
 * - stack traces avec `sk_test_*` / `whsec_*` / Bearer → REDACTED inline
 * - tags PII strippés
 * - cycles + profondeur bornés (anti-DoS)
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/node'

import {
  REDACTED,
  deepSanitize,
  isSensitiveKey,
  redactSecretsInString,
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeUrl,
} from './sanitize'

describe('observability/sentry/sanitize', () => {
  describe('isSensitiveKey', () => {
    it.each([
      ['Authorization', true],
      ['authorization', true],
      ['AUTHORIZATION', true],
      ['x-api-key', true],
      ['stripe-signature', true],
      ['idempotency-key', true],
      ['password', true],
      ['userPassword', true],
      ['passwordHash', true],
      ['refresh_token', true],
      ['refreshToken', true],
      ['sessionToken', true],
      ['client_secret', true],
      ['clientSecret', true],
      ['cardNumber', true],
      ['card_number', true],
      ['payment_method', true],
      ['paymentMethod', true],
      ['cvv', true],
      ['email', true],
      ['user_email', true],
      ['phoneNumber', true],
      ['firstName', true],
      ['lastName', true],
      ['street', true],
      ['captureClientUuid', true],
      ['capture_client_uuid', true],
      ['gpsLat', true],
      ['gps_lng', true],
      ['gps', true],
      ['coords', true],
      ['geolocation', true],
      ['latitude', true],
      ['longitude', true],
      ['signature', true],
      ['api_secret', true],
      ['cookie', true],
      ['set-cookie', true],
      // Allowed: UUID identifiers + business non-PII
      ['userId', false],
      ['user_id', false],
      ['missionId', false],
      ['mission_id', false],
      ['paymentId', false],
      ['requestId', false],
      ['traceId', false],
      ['jobId', false],
      ['amount', false],
      ['status', false],
      ['createdAt', false],
    ])('isSensitiveKey(%s) → %s', (key, expected) => {
      expect(isSensitiveKey(key)).toBe(expected)
    })
  })

  describe('redactSecretsInString', () => {
    it('redacts Bearer JWT', () => {
      const out = redactSecretsInString(
        'Failed: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEFghi',
      )
      expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
      expect(out).toContain(REDACTED)
    })

    it('redacts sk_test_ keys', () => {
      const out = redactSecretsInString('Stripe rejected request with key sk_test_51AbcDEfGhIjK')
      expect(out).not.toContain('sk_test_51AbcDEfGhIjK')
      expect(out).toContain(REDACTED)
    })

    it('redacts sk_live_ keys', () => {
      const out = redactSecretsInString('Production: sk_live_99XyZqrStUvWxYz')
      expect(out).not.toContain('sk_live_99XyZqrStUvWxYz')
      expect(out).toContain(REDACTED)
    })

    it('redacts whsec_ webhook secret', () => {
      const out = redactSecretsInString('Webhook header parsed: whsec_AbCdEfGhIjKlMnOpQrStUv')
      expect(out).not.toContain('whsec_AbCdEfGhIjKlMnOpQrStUv')
      expect(out).toContain(REDACTED)
    })

    it('redacts PaymentIntent client_secret inline', () => {
      const out = redactSecretsInString('intent id pi_3MX12_secret_AbcXyz123')
      expect(out).not.toMatch(/pi_3MX12_secret_AbcXyz123/)
      expect(out).toContain(REDACTED)
    })

    it('redacts standalone JWTs not behind Bearer', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEFghi'
      const out = redactSecretsInString(`token=${jwt}`)
      expect(out).not.toContain(jwt)
    })

    it('leaves non-secret messages untouched', () => {
      const msg = 'Mission abc-123 transitioned to COMPLETED at 2026-05-12T18:00:00Z'
      expect(redactSecretsInString(msg)).toBe(msg)
    })
  })

  describe('sanitizeUrl', () => {
    it('redacts signature query param (Cloudinary)', () => {
      const out = sanitizeUrl(
        'https://res.cloudinary.com/cleanconnect/upload?signature=abc123def&public_id=foo',
      )
      expect(out).toContain('signature=%5BREDACTED%5D')
      expect(out).toContain('public_id=foo')
    })

    it('redacts OAuth-style code', () => {
      const out = sanitizeUrl('https://example.com/callback?code=topsecret&state=ok')
      expect(out).toContain('code=%5BREDACTED%5D')
      expect(out).toContain('state=ok')
    })

    it('returns invalid URL as-is', () => {
      expect(sanitizeUrl('not-a-url')).toBe('not-a-url')
      expect(sanitizeUrl('')).toBe('')
    })

    it('leaves non-sensitive URL untouched', () => {
      const url = 'https://api.cleanconnect.fr/missions/abc-123?expand=client'
      expect(sanitizeUrl(url)).toBe(url)
    })
  })

  describe('deepSanitize', () => {
    it('redacts top-level secret keys', () => {
      const out = deepSanitize({
        password: 'hunter2',
        refreshToken: 'rt_xxx',
        userId: 'user-uuid',
      })
      expect(out.password).toBe(REDACTED)
      expect(out.refreshToken).toBe(REDACTED)
      expect(out.userId).toBe('user-uuid')
    })

    it('redacts nested secret keys (3 levels)', () => {
      const out = deepSanitize({
        user: { profile: { email: 'a@b.c', firstName: 'Alice' }, id: 'uuid' },
      })
      expect(out.user.profile.email).toBe(REDACTED)
      expect(out.user.profile.firstName).toBe(REDACTED)
      expect(out.user.id).toBe('uuid')
    })

    it('redacts inside arrays', () => {
      const out = deepSanitize({
        items: [
          { email: 'a@b.c', amount: 100 },
          { password: 'x', amount: 200 },
        ],
      })
      expect(out.items[0].email).toBe(REDACTED)
      expect(out.items[0].amount).toBe(100)
      expect(out.items[1].password).toBe(REDACTED)
    })

    it('redacts Stripe-shaped event payload (BullMQ webhook job data)', () => {
      const job = {
        eventId: 'evt_123',
        event: {
          id: 'evt_123',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_xxx',
              client_secret: 'pi_xxx_secret_yyy',
              payment_method: 'pm_zzz',
              latest_charge: 'ch_123',
            },
          },
        },
      }
      const out = deepSanitize(job)
      expect(out.event.data.object.client_secret).toBe(REDACTED)
      expect(out.event.data.object.payment_method).toBe(REDACTED)
      expect(out.event.data.object.id).toBe('pi_xxx')
      expect(out.event.type).toBe('payment_intent.succeeded')
    })

    it('redacts GPS coordinates and address street', () => {
      const out = deepSanitize({
        mission: {
          id: 'mission-1',
          address: { street: '12 rue de la Paix', city: 'Paris', postalCode: '75002' },
          // Tout le sous-objet `gps` est redacted en bloc (parent-level
          // redaction, cf. CLASS_C_KEY_PATTERNS).
          gps: { lat: 48.86, lng: 2.33 },
        },
      })
      expect(out.mission.address.street).toBe(REDACTED)
      expect(out.mission.address.postalCode).toBe(REDACTED)
      expect(out.mission.address.city).toBe('Paris')
      expect(out.mission.gps).toBe(REDACTED)
      expect(out.mission.id).toBe('mission-1')
    })

    it('preserves primitives and structure', () => {
      const input = { count: 42, ok: true, ratio: 0.18, nothing: null, missing: undefined }
      const out = deepSanitize(input)
      expect(out).toEqual(input)
    })

    it('detects cycles without crashing', () => {
      const a: Record<string, unknown> = { name: 'a' }
      const b: Record<string, unknown> = { name: 'b', a }
      a.b = b
      const out = deepSanitize(a) as Record<string, unknown>
      expect(out.name).toBe('a')
      expect((out.b as Record<string, unknown>).name).toBe('b')
      expect(((out.b as Record<string, unknown>).a as unknown)).toBe(REDACTED)
    })

    it('truncates absurd array lengths', () => {
      const huge = Array.from({ length: 5000 }, (_, i) => ({ idx: i }))
      const out = deepSanitize({ items: huge }) as { items: unknown[] }
      expect(out.items.length).toBeLessThanOrEqual(100)
    })
  })

  describe('sanitizeBreadcrumb', () => {
    it('redacts fetch breadcrumb URL with signature', () => {
      const crumb: Breadcrumb = {
        category: 'fetch',
        type: 'http',
        data: {
          url: 'https://res.cloudinary.com/x?signature=secret&public_id=foo',
          method: 'POST',
        },
      }
      const out = sanitizeBreadcrumb(crumb)
      expect(out).not.toBeNull()
      expect((out!.data as { url: string }).url).toContain('signature=%5BREDACTED%5D')
      expect((out!.data as { url: string }).url).toContain('public_id=foo')
    })

    it('redacts secret keys nested in breadcrumb data', () => {
      const crumb: Breadcrumb = {
        category: 'http',
        data: { request: { headers: { Authorization: 'Bearer xxx' } }, statusCode: 200 },
      }
      const out = sanitizeBreadcrumb(crumb)
      expect(out).not.toBeNull()
      expect(
        ((out!.data as { request: { headers: Record<string, string> } }).request.headers
          .Authorization),
      ).toBe(REDACTED)
    })

    it('drops console.debug breadcrumbs', () => {
      const crumb: Breadcrumb = { category: 'console', level: 'debug', message: 'noise' }
      expect(sanitizeBreadcrumb(crumb)).toBeNull()
    })

    it('redacts secrets inline in message', () => {
      const crumb: Breadcrumb = {
        category: 'console',
        level: 'error',
        message: 'API key: sk_test_AbCdEf123 rejected',
      }
      const out = sanitizeBreadcrumb(crumb)!
      expect(out.message).not.toContain('sk_test_AbCdEf123')
      expect(out.message).toContain(REDACTED)
    })
  })

  describe('sanitizeEvent', () => {
    it('strips Authorization + Cookie headers', () => {
      const event: ErrorEvent = {
        type: undefined,
        request: {
          url: 'https://api.cleanconnect.fr/v1/payments/intent',
          headers: {
            authorization: 'Bearer abc',
            'stripe-signature': 't=123,v1=def',
            'idempotency-key': 'idem-1',
            'x-request-id': 'req-uuid',
            'content-type': 'application/json',
          },
        },
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      const headers = out.request!.headers as Record<string, string>
      expect(headers.authorization).toBe(REDACTED)
      expect(headers['stripe-signature']).toBe(REDACTED)
      expect(headers['idempotency-key']).toBe(REDACTED)
      expect(headers['x-request-id']).toBe('req-uuid')
      expect(headers['content-type']).toBe('application/json')
    })

    it('strips cookies completely', () => {
      const event: ErrorEvent = {
        type: undefined,
        request: { cookies: { session: 'abc', csrf: 'xyz' } } as unknown as ErrorEvent['request'],
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      const requestBag = out.request as unknown as Record<string, unknown>
      expect(requestBag.cookies).toBe(REDACTED)
    })

    it('deep-sanitizes request body', () => {
      const event: ErrorEvent = {
        type: undefined,
        request: {
          data: {
            password: 'hunter2',
            email: 'alice@example.com',
            userId: 'uuid-1',
            gpsLat: 48.86,
          },
        },
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      const body = out.request!.data as Record<string, unknown>
      expect(body.password).toBe(REDACTED)
      expect(body.email).toBe(REDACTED)
      expect(body.gpsLat).toBe(REDACTED)
      expect(body.userId).toBe('uuid-1')
    })

    it('reduces user context to id only', () => {
      const event: ErrorEvent = {
        type: undefined,
        user: { id: 'uuid', email: 'alice@example.com', username: 'alice' },
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      expect(out.user).toEqual({ id: 'uuid' })
    })

    it('strips sensitive tags', () => {
      const event: ErrorEvent = {
        type: undefined,
        tags: { route: '/v1/payments', email: 'leak@x.fr', requestId: 'req-1' },
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      expect(out.tags).toEqual({ route: '/v1/payments', requestId: 'req-1' })
    })

    it('redacts secrets in exception message + breadcrumbs', () => {
      const event: ErrorEvent = {
        type: undefined,
        message: 'Stripe call failed with sk_test_AbCdEf123',
        exception: {
          values: [{ type: 'Error', value: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y' }],
        },
        breadcrumbs: [
          {
            category: 'fetch',
            data: { url: 'https://x?signature=secret', method: 'GET' },
          },
        ],
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      expect(out.message).not.toContain('sk_test_AbCdEf123')
      expect(out.exception!.values![0].value).not.toContain('eyJhbGciOiJIUzI1NiJ9.x.y')
      expect((out.breadcrumbs![0].data as { url: string }).url).toContain('signature=%5BREDACTED%5D')
    })

    it('redacts query_string signed URLs', () => {
      const event: ErrorEvent = {
        type: undefined,
        request: { query_string: 'signature=topsecret&expand=client' },
      } as ErrorEvent
      const out = sanitizeEvent(event)!
      expect(out.request!.query_string).toContain('signature=%5BREDACTED%5D')
      expect(out.request!.query_string).toContain('expand=client')
    })

    it('handles event without request gracefully', () => {
      const event: ErrorEvent = { type: undefined, message: 'plain error' } as ErrorEvent
      expect(() => sanitizeEvent(event)).not.toThrow()
    })
  })
})
