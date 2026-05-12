/**
 * Tests unitaires — `StripeClientFactory` (PRD-003 Ticket 3.1).
 *
 * Cible : garantir l'invariant ADR-011 (`apiVersion` pinned, jamais `latest`).
 * On ne fait PAS de mock du SDK : `new Stripe(...)` est synchrone, n'effectue
 * aucune requête tant qu'on n'appelle pas d'API (cf. doc Stripe).
 */

import Stripe from 'stripe'

import { __resetEnvCacheForTests } from '../../../common/config/env'

import { StripeClientFactory } from './stripe.client'

describe('StripeClientFactory (PRD-003 Ticket 3.1 — ADR-011)', () => {
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_unit_factory'
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_unit_factory_secret_min_32chars_aaaa'
    process.env['STRIPE_API_VERSION'] = '2025-02-24.acacia'
    process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] = '300'
    process.env['NODE_ENV'] = 'development'
    process.env['APP_ENV'] = 'development'
    process.env['FF_PAYMENTS_ENABLED'] = 'true'
    process.env['DATABASE_URL'] = 'postgresql://unit:unit@localhost:5499/unit'
    process.env['REDIS_URL'] = 'redis://localhost:6399'
    process.env['CORS_ORIGINS'] = 'http://localhost:5173'
    process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48)
    process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48)
    process.env['APP_VERSION'] = '0.0.0-test'

    __resetEnvCacheForTests()
  })

  it('builds Stripe SDK avec apiVersion pinnée depuis env', () => {
    const factory = new StripeClientFactory()
    const client = factory.build()
    expect(client).toBeInstanceOf(Stripe)
    // L'apiVersion est exposée par le SDK via `client.getApiField`. On consulte
    // la config interne (typings privés mais stables — surveillance à chaque
    // bump SDK).
    const version = (client as unknown as { _api: { version: string } })._api.version
    expect(version).toBe('2025-02-24.acacia')
  })

  it('échoue si STRIPE_API_VERSION ne respecte pas le format YYYY-MM-DD.codename', () => {
    process.env['STRIPE_API_VERSION'] = 'latest'
    __resetEnvCacheForTests()
    expect(() => new StripeClientFactory().build()).toThrow(/Environnement invalide/u)
  })
})
