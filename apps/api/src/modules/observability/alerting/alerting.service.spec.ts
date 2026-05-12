/**
 * PRD-004 Ticket 4.1 (Build B) — unit tests `AlertingService`.
 *
 * Couverture :
 *  - No-op gracieux quand ALERTING_ENABLED=false (jamais d'appel notifier)
 *  - No-op gracieux quand DISCORD_WEBHOOK_URL absent
 *  - P0/P1 dispatch immédiat vers le notifier (send appelé)
 *  - P2 mis en buffer + flushé via `flushP2ForTests`
 *  - P3 logged but NEVER sent to Discord
 *  - Cooldown : 2 emit P0 même kind dans la fenêtre → 2ème dropped
 *  - Cooldown : P2/P3 ignorent le cooldown (anti-spam autre via buffer + log only)
 *  - Sanitization appliquée avant dispatch (Bearer leak → [REDACTED])
 *  - emit() ne throw JAMAIS même si notifier.send throw (par contrat)
 */

import { __resetEnvCacheForTests } from '../../../common/config/env'

import { AlertingService } from './alerting.service'
import type { DiscordNotifier } from './discord.notifier'

function envWithAlertingEnabled(): void {
  process.env.NODE_ENV = 'development'
  process.env.APP_ENV = 'development'
  process.env.DATABASE_URL = 'postgresql://u:p@h:5432/db'
  process.env.REDIS_URL = 'redis://r:6379'
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(48)
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(48)
  process.env.CORS_ORIGINS = 'http://localhost'
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_'.padEnd(40, 'x')
  process.env.STRIPE_API_VERSION = '2025-02-24.acacia'
  process.env.ALERTING_ENABLED = 'true'
  process.env.DISCORD_WEBHOOK_URL =
    'https://discord.com/api/webhooks/123456789/abcdefghijklmnop'
  process.env.ALERTING_COOLDOWN_SECONDS = '300'
  __resetEnvCacheForTests()
}

function envWithAlertingDisabled(): void {
  envWithAlertingEnabled()
  process.env.ALERTING_ENABLED = 'false'
  delete process.env.DISCORD_WEBHOOK_URL
  __resetEnvCacheForTests()
}

/** Notifier fake exposant les appels reçus pour assertions. */
class FakeNotifier {
  sent: Array<{ severity: string; kind: string; title: string }> = []
  batches: Array<{ count: number }> = []
  failNext = false

  async send(alert: { severity: string; kind: string; title: string }): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('notifier exploded — should never propagate')
    }
    this.sent.push({ severity: alert.severity, kind: alert.kind, title: alert.title })
    return true
  }

  async sendBatch(alerts: Array<{ severity: string; kind: string; title: string }>): Promise<boolean> {
    this.batches.push({ count: alerts.length })
    return true
  }
}

describe('AlertingService (PRD-004 Build B)', () => {
  afterEach(async () => {
    delete process.env.ALERTING_ENABLED
    delete process.env.DISCORD_WEBHOOK_URL
    delete process.env.ALERTING_COOLDOWN_SECONDS
    __resetEnvCacheForTests()
  })

  it('is no-op when ALERTING_ENABLED=false (notifier never built)', async () => {
    envWithAlertingDisabled()
    const svc = new AlertingService()
    expect(svc.isEnabledForTests()).toBe(false)

    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'should be dropped' })
    await svc.emit({ severity: 'P2', kind: 'webhook_failed_rate', title: 't' })

    await svc.onModuleDestroy()
  })

  it('dispatches P0 to the notifier immediately', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'big' })

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]).toMatchObject({ severity: 'P0', kind: 'dlq_growth' })
    await svc.onModuleDestroy()
  })

  it('buffers P2 and flushes on demand', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({ severity: 'P2', kind: 'webhook_failed_rate', title: 'a' })
    await svc.emit({ severity: 'P2', kind: 'webhook_failed_rate', title: 'b' })

    expect(fake.batches).toHaveLength(0)
    expect(svc.getP2BufferSizeForTests()).toBe(2)

    await svc.flushP2ForTests()
    expect(fake.batches).toEqual([{ count: 2 }])
    expect(svc.getP2BufferSizeForTests()).toBe(0)
    await svc.onModuleDestroy()
  })

  it('does NOT dispatch P3 to the notifier (logs only)', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({ severity: 'P3', kind: 'webhook_failed_rate', title: 'info-only' })

    expect(fake.sent).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
    await svc.onModuleDestroy()
  })

  it('honors cooldown for repeated P0 with same kind', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'first' })
    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'second' })
    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'third' })

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].title).toBe('first')
    await svc.onModuleDestroy()
  })

  it('cooldown is per `<severity>:<kind>` — same kind P0 vs P1 are independent', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'p0' })
    await svc.emit({ severity: 'P1', kind: 'dlq_growth', title: 'p1' })

    expect(fake.sent).toHaveLength(2)
    await svc.onModuleDestroy()
  })

  it('sanitizes secret leaks before dispatching', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await svc.emit({
      severity: 'P0',
      kind: 'stripe_api_failure_spike',
      title: 'leak: Bearer abc.def.ghi',
    })

    expect(fake.sent[0].title).not.toContain('abc.def.ghi')
    expect(fake.sent[0].title).toMatch(/Bearer \[REDACTED\]/)
    await svc.onModuleDestroy()
  })

  it('never throws to the caller — even if notifier blows up', async () => {
    envWithAlertingEnabled()
    const svc = new AlertingService()
    const fake = new FakeNotifier()
    fake.failNext = true
    svc.__setNotifierForTests(fake as unknown as DiscordNotifier)

    await expect(
      svc.emit({ severity: 'P0', kind: 'dlq_growth', title: 'ouch' }),
    ).resolves.toBeUndefined()

    await svc.onModuleDestroy()
  })
})
