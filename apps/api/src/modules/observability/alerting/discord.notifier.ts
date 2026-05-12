/**
 * PRD-004 Ticket 4.1 (Build B) — Discord webhook notifier.
 *
 * Responsabilité : sérialiser un `AlertPayload` (déjà sanitisé) en embed Discord
 * et POSTer sur le webhook configuré. Aucune logique métier ici.
 *
 * Sécurité :
 *  - Le payload reçu DOIT déjà avoir traversé `sanitizeForAlert` (contrat).
 *  - Aucun `process.env.*` lu ici → injection de `DISCORD_WEBHOOK_URL` par le
 *    caller (`AlertingService`) pour facilité de mock + isolation des tests.
 *  - Timeout `AbortSignal.timeout(5_000)` → ne bloque jamais l'application.
 *  - Aucun retry interne → si Discord 5xx, on log + drop. `AlertingService`
 *    peut implémenter un retry-policy au niveau supérieur si besoin (P0 only).
 *
 * Format Discord embed :
 *  - `color` ← ALERT_COLORS[severity]
 *  - `title` ← `[<severity>][<kind>] <input.title>`
 *  - `description` ← `input.description`
 *  - `fields` ← `input.context` (au max 12 — déjà cappé par sanitizeForAlert)
 *  - `timestamp` ← ISO8601 now
 *  - `footer.text` ← `clean-connect@<env>`
 */

import { Logger } from '@nestjs/common'

import { ALERT_COLORS, type AlertPayload } from './alerting.types'

export interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

export interface DiscordEmbed {
  title: string
  description?: string
  color: number
  fields?: DiscordEmbedField[]
  timestamp: string
  footer?: { text: string }
}

export interface DiscordWebhookBody {
  username?: string
  embeds: DiscordEmbed[]
}

export interface DiscordNotifierDeps {
  webhookUrl: string
  environment: string
  /** Injecté pour mock dans les tests. Defaut `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Timeout HTTP (ms). Défaut 5000. */
  timeoutMs?: number
}

const MAX_FIELD_NAME = 96
const MAX_FIELD_VALUE = 256

export class DiscordNotifier {
  private readonly logger = new Logger(DiscordNotifier.name)
  private readonly webhookUrl: string
  private readonly environment: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(deps: DiscordNotifierDeps) {
    this.webhookUrl = deps.webhookUrl
    this.environment = deps.environment
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = deps.timeoutMs ?? 5_000
  }

  /**
   * Envoie une alerte sanitisée à Discord. Retourne `true` si le POST réussit
   * (HTTP 2xx), `false` sinon. Ne throw JAMAIS (par contrat — Alerting ne doit
   * pas casser le runtime applicatif).
   */
  async send(alert: AlertPayload): Promise<boolean> {
    const body = this.buildBody(alert)
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, kind: alert.kind, severity: alert.severity },
          'alerting.discord.non_2xx',
        )
        return false
      }
      return true
    } catch (err) {
      this.logger.error(
        { err, kind: alert.kind, severity: alert.severity },
        'alerting.discord.failed',
      )
      return false
    }
  }

  /**
   * Envoie un batch d'alertes P2 agrégées en un seul POST (1 embed = 1 alert).
   * Évite la rate-limit Discord (5 messages/s par webhook).
   */
  async sendBatch(alerts: AlertPayload[]): Promise<boolean> {
    if (alerts.length === 0) return true
    const body: DiscordWebhookBody = {
      username: `clean-connect alerts (${this.environment})`,
      // Discord max 10 embeds/message — borne le batch.
      embeds: alerts.slice(0, 10).map((a) => this.buildEmbed(a)),
    }
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, count: alerts.length },
          'alerting.discord.batch.non_2xx',
        )
        return false
      }
      return true
    } catch (err) {
      this.logger.error({ err, count: alerts.length }, 'alerting.discord.batch.failed')
      return false
    }
  }

  buildBody(alert: AlertPayload): DiscordWebhookBody {
    return {
      username: `clean-connect alerts (${this.environment})`,
      embeds: [this.buildEmbed(alert)],
    }
  }

  buildEmbed(alert: AlertPayload): DiscordEmbed {
    const fields: DiscordEmbedField[] | undefined =
      alert.context === undefined
        ? undefined
        : Object.entries(alert.context).map(([k, v]) => ({
            name: k.slice(0, MAX_FIELD_NAME),
            value: serializeFieldValue(v).slice(0, MAX_FIELD_VALUE),
            inline: true,
          }))

    return {
      title: `[${alert.severity}][${alert.kind}] ${alert.title}`,
      description: alert.description,
      color: ALERT_COLORS[alert.severity],
      ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
      timestamp: new Date().toISOString(),
      footer: { text: `clean-connect@${this.environment}` },
    }
  }
}

function serializeFieldValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v).slice(0, MAX_FIELD_VALUE)
  } catch {
    return '[unserializable]'
  }
}
