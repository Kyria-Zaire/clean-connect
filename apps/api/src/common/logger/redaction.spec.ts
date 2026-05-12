/**
 * Tests redaction Pino (PRD-004 Ticket 4.1 — Build A2).
 *
 * Stratégie :
 * - On instancie un **vrai logger pino** avec la même config redact que
 *   `app.module.ts` (paths classes A/B/C), redirigé vers un buffer.
 * - On émet un événement avec un payload réaliste (HTTP req, BullMQ job,
 *   webhook Stripe brut, etc.) et on assert que chaque chemin sensible
 *   est `[REDACTED]` dans la sortie JSON.
 *
 * Couverture obligatoire CTO :
 * - classe A (secrets/tokens/cookies/Authorization/idempotency-key)
 * - classe B (cardNumber / payment_method / bankAccount)
 * - classe C (email / phone / firstName / street / gps / IP)
 * - nested 3+ levels
 * - arrays of secrets
 * - BullMQ job payload (webhook Stripe complet)
 * - snapshot lock-in pour empêcher régression silencieuse de la liste.
 */

import pino from 'pino'

import { pinoLogFormatter } from './log-sanitizer'
import { REDACTION_CENSOR, REDACTION_CLASSES, REDACTION_PATHS } from './redaction'

interface CapturedEntry {
  level?: number
  msg?: string
  [key: string]: unknown
}

/**
 * Crée un logger pino qui écrit chaque entrée dans `entries[]` (test-only).
 */
function buildCapturingLogger(): { logger: pino.Logger; entries: CapturedEntry[] } {
  const entries: CapturedEntry[] = []
  const logger = pino(
    {
      level: 'debug',
      redact: {
        paths: [...REDACTION_PATHS],
        censor: REDACTION_CENSOR,
      },
      // Couvre les wildcards profonds (BullMQ jobs, Stripe webhook payloads)
      // que `fast-redact` ne peut pas atteindre via paths plats.
      formatters: {
        log: pinoLogFormatter,
      },
    },
    {
      write(chunk: string): void {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue
          entries.push(JSON.parse(line) as CapturedEntry)
        }
      },
    },
  )
  return { logger, entries }
}

describe('common/logger/redaction (Pino paths)', () => {
  describe('snapshot lock-in', () => {
    it('exhaustive list does not regress without explicit change', () => {
      expect(REDACTION_PATHS).toMatchSnapshot('all-paths')
    })

    it('class A still covers Authorization + Stripe signature + idempotency', () => {
      expect(REDACTION_CLASSES.A).toEqual(expect.arrayContaining([
        'req.headers.authorization',
        'req.headers["stripe-signature"]',
        'req.headers["idempotency-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.refreshToken',
        '*.accessToken',
        '*.sessionToken',
        '*.client_secret',
      ]))
    })

    it('class B still covers card + bank + payment_method', () => {
      expect(REDACTION_CLASSES.B).toEqual(expect.arrayContaining([
        '*.cardNumber',
        '*.card.number',
        '*.cvv',
        '*.payment_method',
        '*.bankAccount',
      ]))
    })

    it('class C still covers PII + GPS + capture UUID + IP', () => {
      expect(REDACTION_CLASSES.C).toEqual(expect.arrayContaining([
        '*.email',
        '*.phone',
        '*.firstName',
        '*.lastName',
        '*.street',
        '*.gps',
        '*.captureClientUuid',
        'req.ip',
      ]))
    })
  })

  describe('redaction runtime — Class A (secrets)', () => {
    it('redacts Authorization + cookies + stripe-signature + idempotency-key in req.headers', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        req: {
          headers: {
            authorization: 'Bearer eyJleak.token',
            cookie: 'session=abc',
            'stripe-signature': 't=123,v1=signaturehex',
            'idempotency-key': 'idem-xyz',
            'content-type': 'application/json',
          },
        },
      }, 'incoming request')

      const e = entries[0]
      const headers = (e.req as { headers: Record<string, string> }).headers
      expect(headers.authorization).toBe(REDACTION_CENSOR)
      expect(headers.cookie).toBe(REDACTION_CENSOR)
      expect(headers['stripe-signature']).toBe(REDACTION_CENSOR)
      expect(headers['idempotency-key']).toBe(REDACTION_CENSOR)
      expect(headers['content-type']).toBe('application/json')
    })

    it('redacts password / *Token / *Secret at any depth', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        user: { id: 'u-1', password: 'hunter2', refreshToken: 'rt_xxx', sessionToken: 'st_yyy' },
        stripe: { client_secret: 'pi_x_secret_y', api_secret: 'sk_test_AbC' },
      }, 'after login')

      const e = entries[0]
      const user = e.user as Record<string, string>
      const stripe = e.stripe as Record<string, string>
      expect(user.password).toBe(REDACTION_CENSOR)
      expect(user.refreshToken).toBe(REDACTION_CENSOR)
      expect(user.sessionToken).toBe(REDACTION_CENSOR)
      expect(user.id).toBe('u-1')
      expect(stripe.client_secret).toBe(REDACTION_CENSOR)
      expect(stripe.api_secret).toBe(REDACTION_CENSOR)
    })

    it('redacts Cloudinary signature in cloudinaryParams + *.signature', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        photo: {
          id: 'photo-1',
          cloudinaryParams: { signature: 'topsecret', api_key: 'k123', timestamp: 1700000000 },
          signature: 'inlineSig',
        },
      }, 'cloudinary signed')

      const photo = entries[0].photo as {
        cloudinaryParams: Record<string, unknown>
        signature: string
      }
      expect(photo.cloudinaryParams.signature).toBe(REDACTION_CENSOR)
      expect(photo.cloudinaryParams.api_key).toBe(REDACTION_CENSOR)
      expect(photo.cloudinaryParams.timestamp).toBe(1700000000)
      expect(photo.signature).toBe(REDACTION_CENSOR)
    })
  })

  describe('redaction runtime — Class B (financial)', () => {
    it('redacts cardNumber + cvv + payment_method + bankAccount', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        payment: {
          intentId: 'pi_1',
          cardNumber: '4242424242424242',
          cvv: '123',
          payment_method: 'pm_card_visa',
          bankAccount: 'ba_xxx',
          amount: 12000,
        },
      }, 'payment processed')

      const p = entries[0].payment as Record<string, unknown>
      expect(p.cardNumber).toBe(REDACTION_CENSOR)
      expect(p.cvv).toBe(REDACTION_CENSOR)
      expect(p.payment_method).toBe(REDACTION_CENSOR)
      expect(p.bankAccount).toBe(REDACTION_CENSOR)
      expect(p.intentId).toBe('pi_1')
      expect(p.amount).toBe(12000)
    })

    it('redacts nested card.number + card.cvc', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({ source: { card: { number: '4242', cvc: '111', brand: 'visa' } } }, 'card')

      const card = (entries[0].source as { card: Record<string, string> }).card
      expect(card.number).toBe(REDACTION_CENSOR)
      expect(card.cvc).toBe(REDACTION_CENSOR)
      expect(card.brand).toBe('visa')
    })
  })

  describe('redaction runtime — Class C (PII)', () => {
    it('redacts email + phone + firstName + lastName + street', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        client: {
          id: 'u-1',
          email: 'alice@example.com',
          phone: '+33600000000',
          firstName: 'Alice',
          lastName: 'Dupont',
        },
        mission: {
          id: 'm-1',
          address: { street: '12 rue de la Paix', postalCode: '75002', city: 'Paris' },
        },
      }, 'mission accepted')

      const c = entries[0].client as Record<string, string>
      const m = entries[0].mission as { address: Record<string, string>; id: string }
      expect(c.email).toBe(REDACTION_CENSOR)
      expect(c.phone).toBe(REDACTION_CENSOR)
      expect(c.firstName).toBe(REDACTION_CENSOR)
      expect(c.lastName).toBe(REDACTION_CENSOR)
      expect(c.id).toBe('u-1')
      expect(m.address.street).toBe(REDACTION_CENSOR)
      expect(m.address.postalCode).toBe(REDACTION_CENSOR)
      expect(m.address.city).toBe('Paris')
      expect(m.id).toBe('m-1')
    })

    it('redacts GPS + captureClientUuid', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        photo: {
          id: 'p-1',
          captureClientUuid: 'uuid-private',
          gps: { lat: 48.86, lng: 2.33 },
          latitude: 48.86,
          longitude: 2.33,
        },
      }, 'photo upload')

      const photo = entries[0].photo as Record<string, unknown>
      expect(photo.captureClientUuid).toBe(REDACTION_CENSOR)
      expect(photo.gps).toBe(REDACTION_CENSOR)
      expect(photo.latitude).toBe(REDACTION_CENSOR)
      expect(photo.longitude).toBe(REDACTION_CENSOR)
      expect(photo.id).toBe('p-1')
    })

    it('redacts client IP (X-Forwarded-For, X-Real-IP, req.ip)', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        req: {
          ip: '1.2.3.4',
          ips: ['1.2.3.4', '5.6.7.8'],
          headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
        },
      }, 'incoming')

      const req = entries[0].req as {
        ip: string
        ips: string[]
        headers: Record<string, string>
      }
      expect(req.ip).toBe(REDACTION_CENSOR)
      expect(req.ips).toBe(REDACTION_CENSOR)
      expect(req.headers['x-forwarded-for']).toBe(REDACTION_CENSOR)
      expect(req.headers['x-real-ip']).toBe(REDACTION_CENSOR)
    })
  })

  describe('redaction runtime — complex payloads', () => {
    it('redacts a complete Stripe webhook BullMQ job payload', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        job: {
          name: 'stripe-webhook',
          data: {
            event: {
              id: 'evt_123',
              type: 'payment_intent.succeeded',
              data: {
                object: {
                  id: 'pi_xxx',
                  client_secret: 'pi_xxx_secret_yyy',
                  payment_method: 'pm_zzz',
                  latest_charge: 'ch_123',
                  amount: 12000,
                  metadata: { missionId: 'm-1', clientId: 'u-1' },
                },
              },
            },
          },
        },
      }, 'webhook job received')

      const obj = (
        entries[0].job as {
          data: { event: { data: { object: Record<string, unknown> } } }
        }
      ).data.event.data.object
      expect(obj.client_secret).toBe(REDACTION_CENSOR)
      expect(obj.payment_method).toBe(REDACTION_CENSOR)
      expect(obj.amount).toBe(12000)
      expect((obj.metadata as Record<string, string>).missionId).toBe('m-1')
    })

    it('redacts arrays of objects containing secrets', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        users: [
          { id: 'u-1', email: 'a@b.c', password: 'p1' },
          { id: 'u-2', email: 'd@e.f', refreshToken: 'rt_2' },
        ],
      }, 'bulk user export')

      const users = entries[0].users as Array<Record<string, string>>
      expect(users[0].email).toBe(REDACTION_CENSOR)
      expect(users[0].password).toBe(REDACTION_CENSOR)
      expect(users[0].id).toBe('u-1')
      expect(users[1].email).toBe(REDACTION_CENSOR)
      expect(users[1].refreshToken).toBe(REDACTION_CENSOR)
    })

    it('does NOT redact safe identifiers (userId, missionId, paymentId, amount, status)', () => {
      const { logger, entries } = buildCapturingLogger()
      logger.info({
        userId: 'user-uuid-1',
        missionId: 'mission-uuid-2',
        paymentId: 'payment-uuid-3',
        amount: 12000,
        status: 'CAPTURED',
        createdAt: '2026-05-12T18:00:00Z',
      }, 'safe identifiers')

      const e = entries[0]
      expect(e.userId).toBe('user-uuid-1')
      expect(e.missionId).toBe('mission-uuid-2')
      expect(e.paymentId).toBe('payment-uuid-3')
      expect(e.amount).toBe(12000)
      expect(e.status).toBe('CAPTURED')
      expect(e.createdAt).toBe('2026-05-12T18:00:00Z')
    })
  })
})
