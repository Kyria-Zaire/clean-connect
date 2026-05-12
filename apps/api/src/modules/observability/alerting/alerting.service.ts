/**
 * PRD-004 Ticket 4.1 (Build B) — Service Alerting.
 *
 * API publique (1 fonction) :
 *   `emit(alert: AlertPayload): Promise<void>`
 *
 * Flow :
 *  1. Sanitization obligatoire via `sanitizeForAlert` (defense-in-depth — même
 *     si le caller a déjà sanitisé, on re-sanitise par contrat).
 *  2. Routage par sévérité :
 *     - P0/P1 → Discord immédiat
 *     - P2    → buffer agrégé, flush toutes les 60s (réduit le bruit)
 *     - P3    → logs only (Pino + sentry — pas de webhook)
 *  3. Cooldown anti-spam : par `<severity>:<kind>`, défaut 5 min (ENV
 *     `ALERTING_COOLDOWN_SECONDS`). Évite qu'une boucle d'erreur sature Discord.
 *  4. Si `ALERTING_ENABLED=false` ou `DISCORD_WEBHOOK_URL` manquant → no-op
 *     gracieux (log debug + métrique). Permet `emit()` partout dans le code
 *     sans nullcheck.
 *
 * Sécurité :
 *  - Le notifier ne reçoit que le payload sanitisé.
 *  - Aucun secret loggué (Pino redactor s'occupe du reste).
 *  - Aucun throw possible vers le caller — alerting ne doit jamais casser le métier.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'

import { loadEnv, type Env } from '../../../common/config/env'

import type { AlertPayload, AlertSeverity } from './alerting.types'
import { DiscordNotifier } from './discord.notifier'
import { sanitizeForAlert } from './sanitize-alert'

const P2_FLUSH_INTERVAL_MS = 60_000
const P2_BUFFER_MAX = 50

@Injectable()
export class AlertingService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertingService.name)
  private readonly env: Env
  private readonly notifier: DiscordNotifier | null
  /** Cooldown key = `<severity>:<kind>` → timestamp ms du dernier envoi. */
  private readonly cooldown = new Map<string, number>()
  /** Buffer P2 — flush périodique. */
  private readonly p2Buffer: AlertPayload[] = []
  private p2FlushTimer: NodeJS.Timeout | null = null

  constructor() {
    this.env = loadEnv()
    this.notifier = this.buildNotifier()
    if (this.notifier !== null) {
      // Démarre la boucle de flush P2 uniquement si on a un notifier réel.
      this.p2FlushTimer = setInterval(() => {
        void this.flushP2()
      }, P2_FLUSH_INTERVAL_MS)
      // `unref()` pour ne pas empêcher l'arrêt graceful du process (tests OK).
      this.p2FlushTimer.unref?.()
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.p2FlushTimer !== null) {
      clearInterval(this.p2FlushTimer)
      this.p2FlushTimer = null
    }
    await this.flushP2()
  }

  /**
   * Émet une alerte. Ne throw jamais. No-op gracieux si alerting désactivé.
   */
  async emit(input: AlertPayload): Promise<void> {
    const sanitized = sanitizeForAlert(input)

    if (this.notifier === null) {
      this.logger.debug(
        { severity: sanitized.severity, kind: sanitized.kind, title: sanitized.title },
        'alerting.disabled.dropped',
      )
      return
    }

    if (this.isUnderCooldown(sanitized)) {
      this.logger.debug(
        { severity: sanitized.severity, kind: sanitized.kind },
        'alerting.cooldown.skipped',
      )
      return
    }

    switch (sanitized.severity) {
      case 'P0':
      case 'P1':
        // Wrap dans try/catch — par contrat `emit()` NE PROPAGE JAMAIS une
        // erreur du notifier (Discord 5xx, network, code throw). Sinon une
        // alerting flaky pourrait casser le métier qui l'a appelée.
        try {
          await this.notifier.send(sanitized)
          this.markSent(sanitized)
        } catch (err) {
          this.logger.error(
            { err, severity: sanitized.severity, kind: sanitized.kind },
            'alerting.dispatch.failed_swallowed',
          )
        }
        return
      case 'P2':
        this.bufferP2(sanitized)
        return
      case 'P3':
        // P3 = informationnel — uniquement logs. Aucun webhook.
        this.logger.log(
          { severity: sanitized.severity, kind: sanitized.kind, title: sanitized.title },
          'alerting.p3.logged',
        )
        return
      default:
        // typescript exhaustiveness — devrait être inatteignable.
        ((_: never) => undefined)(sanitized.severity)
    }
  }

  /**
   * @internal — exposé pour les tests pour observer l'état du buffer P2 sans
   * attendre le tick du setInterval (60s).
   */
  async flushP2ForTests(): Promise<void> {
    await this.flushP2()
  }

  /**
   * @internal — exposé pour les tests pour réinitialiser le cooldown.
   */
  resetCooldownForTests(): void {
    this.cooldown.clear()
  }

  private buildNotifier(): DiscordNotifier | null {
    if (!this.env.ALERTING_ENABLED || this.env.DISCORD_WEBHOOK_URL === undefined) {
      return null
    }
    return new DiscordNotifier({
      webhookUrl: this.env.DISCORD_WEBHOOK_URL,
      environment: this.env.APP_ENV,
    })
  }

  private cooldownKey(alert: AlertPayload): string {
    return `${alert.severity}:${alert.kind}`
  }

  private isUnderCooldown(alert: AlertPayload): boolean {
    if (alert.severity === 'P2' || alert.severity === 'P3') return false
    const last = this.cooldown.get(this.cooldownKey(alert))
    if (last === undefined) return false
    const elapsedSeconds = (Date.now() - last) / 1_000
    return elapsedSeconds < this.env.ALERTING_COOLDOWN_SECONDS
  }

  private markSent(alert: AlertPayload): void {
    this.cooldown.set(this.cooldownKey(alert), Date.now())
  }

  private bufferP2(alert: AlertPayload): void {
    if (this.p2Buffer.length >= P2_BUFFER_MAX) {
      // Anti-spam dur — on garde les premières alertes du tick et on drop le reste.
      this.logger.warn(
        { kind: alert.kind, dropped: true },
        'alerting.p2.buffer_full_dropped',
      )
      return
    }
    this.p2Buffer.push(alert)
  }

  private async flushP2(): Promise<void> {
    if (this.notifier === null || this.p2Buffer.length === 0) return
    const batch = this.p2Buffer.splice(0, this.p2Buffer.length)
    await this.notifier.sendBatch(batch)
  }

  /** @internal — exposé pour debug + tests. */
  getCooldownSizeForTests(): number {
    return this.cooldown.size
  }

  /** @internal — exposé pour debug + tests. */
  getP2BufferSizeForTests(): number {
    return this.p2Buffer.length
  }

  /** @internal — exposé pour debug + tests. */
  isEnabledForTests(): boolean {
    return this.notifier !== null
  }

  /** @internal — exposé pour les tests pour injecter un notifier mock. */
  __setNotifierForTests(n: DiscordNotifier | null): void {
    ;(this as unknown as { notifier: DiscordNotifier | null }).notifier = n
  }

  /** @internal — métadonnées pour `metrics`. */
  getCurrentSeverityCounts(): Record<AlertSeverity, number> {
    const counts: Record<AlertSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
    for (const key of this.cooldown.keys()) {
      const sev = key.split(':', 1)[0] as AlertSeverity
      counts[sev] = (counts[sev] ?? 0) + 1
    }
    return counts
  }
}
