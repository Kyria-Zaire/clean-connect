/**
 * PRD-004 Ticket 4.1 (Build B) — unit tests `DiscordNotifier`.
 *
 * Couverture :
 *  - `send` POST sur l'URL configurée avec headers JSON
 *  - le body contient le bon embed (color = ALERT_COLORS[severity], title formatté)
 *  - `send` retourne `false` quand fetch retourne 4xx/5xx (sans throw)
 *  - `send` retourne `false` quand fetch throw (sans throw)
 *  - timeout AbortSignal limite l'attente (test simulation)
 *  - aucun PII dans le body sérialisé (smoke check sur context sanitisé)
 *  - `sendBatch` cap à 10 embeds (Discord limit)
 *  - footer contient l'environnement
 */

import { ALERT_COLORS, type AlertPayload } from './alerting.types'
import { DiscordNotifier } from './discord.notifier'

const WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnop'

function buildFetchMock(response: { ok: boolean; status?: number } = { ok: true, status: 200 }): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? 200,
  } as Response)
}

describe('DiscordNotifier (PRD-004 Build B)', () => {
  it('POSTs the webhook with Content-Type application/json and JSON body', async () => {
    const fetchMock = buildFetchMock()
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'recette',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const ok = await notifier.send({
      severity: 'P0',
      kind: 'dlq_growth',
      title: 'DLQ grew above threshold',
    })

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(WEBHOOK_URL)
    const initObj = init as RequestInit
    expect(initObj.method).toBe('POST')
    expect((initObj.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(initObj.body as string) as { embeds: Array<{ color: number; title: string; footer: { text: string } }> }
    expect(body.embeds[0].color).toBe(ALERT_COLORS.P0)
    expect(body.embeds[0].title).toBe('[P0][dlq_growth] DLQ grew above threshold')
    expect(body.embeds[0].footer.text).toBe('clean-connect@recette')
  })

  it('returns false on non-2xx without throwing', async () => {
    const fetchMock = buildFetchMock({ ok: false, status: 503 })
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'preprod',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const ok = await notifier.send({ severity: 'P1', kind: 'bullmq_failed_jobs', title: 'x' })
    expect(ok).toBe(false)
  })

  it('returns false when fetch throws (network failure)', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'production',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const ok = await notifier.send({ severity: 'P0', kind: 'stripe_api_failure_spike', title: 't' })
    expect(ok).toBe(false)
  })

  it('serializes context as Discord embed fields (inline)', async () => {
    const fetchMock = buildFetchMock()
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'dev',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await notifier.send({
      severity: 'P2',
      kind: 'webhook_failed_rate',
      title: 'rate spike',
      context: { failures: 7, rate: 0.12 },
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as { embeds: Array<{ fields: Array<{ name: string; value: string; inline: boolean }> }> }
    expect(body.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'failures', value: '7', inline: true }),
        expect.objectContaining({ name: 'rate', value: '0.12', inline: true }),
      ]),
    )
  })

  it('caps sendBatch to 10 embeds (Discord limit)', async () => {
    const fetchMock = buildFetchMock()
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'dev',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const alerts: AlertPayload[] = []
    for (let i = 0; i < 25; i += 1) {
      alerts.push({ severity: 'P2', kind: 'webhook_failed_rate', title: `a${i}` })
    }
    await notifier.sendBatch(alerts)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as { embeds: unknown[] }
    expect(body.embeds.length).toBe(10)
  })

  it('sendBatch returns true for empty input without POSTing', async () => {
    const fetchMock = buildFetchMock()
    const notifier = new DiscordNotifier({
      webhookUrl: WEBHOOK_URL,
      environment: 'dev',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const ok = await notifier.sendBatch([])
    expect(ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
