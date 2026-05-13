/**
 * PRD-004 Ticket 4.5 — `FinanceAlertingService`.
 *
 * Source de vérité : PRD-004 §4.15.7 + ADR-018 §2.5.
 *
 * Émet une alerte finance et :
 *  1. Persiste un row `FinanceAlert` (audit cooldown post-mortem — OQ-11).
 *  2. Log structuré Pino (`finance.alert.<kind>`) avec contexte sanitizé.
 *  3. (TODO debt) — délègue à `AlertingService` global (Discord/Resend) quand
 *     PR #20 mergée (Ticket 4.1 Build B).
 *
 * **Cooldown anti-spam** : implémentation en mémoire (Map) — suffisant car le
 * service est singleton (`@Injectable`). Le cooldown est exprimé par
 * `(kind, scope)` où `scope` est un discriminant fonctionnel (ex.
 * `mismatchType`, `prestataireIdShort`, `resourceIdTruncated`). Aucune PII.
 *
 * Cooldown table — figée Design PRD-004 §4.15.7 :
 *  - `finance_mismatch` ............... 15 min / `mismatchType`
 *  - `finance_stuck_authorization` .... 4 h / `resourceIdTruncated`
 *  - `finance_stuck_captured_funds` ... 1 h / `resourceIdTruncated`
 *  - `finance_transfer_pending` ....... 30 min (P2 batch, scope none)
 *  - `finance_refund_mismatch` ........ 15 min / `kind`
 *  - `finance_invariant_break` ........ 1 h / `invariant`
 *  - `finance_reconcile_failed` ....... 30 min (scope `runType`)
 *  - `finance_report_missing` ......... 24 h
 *  - `finance_payout_anomaly` ......... 24 h / `prestataireIdShort`
 *
 * Tests obligatoires (Condition Build #4 sécu pre-review) :
 *  - PII jamais présent dans `FinanceAlert.context`
 *  - Cooldown respecté
 *  - Reset entre tests via `__resetCooldownForTests`
 */

import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { deepSanitize } from '../../../common/security/sanitize'
import {
  FINANCE_METRIC_LABELS,
  type FinanceSeverity,
} from '../finance.constants'

/** Liste exhaustive des kinds — figée Design PRD-004 §4.15.7. */
export const FINANCE_ALERT_KINDS = [
  'finance_mismatch',
  'finance_stuck_authorization',
  'finance_stuck_captured_funds',
  'finance_transfer_pending',
  'finance_refund_mismatch',
  'finance_invariant_break',
  'finance_reconcile_failed',
  'finance_report_missing',
  'finance_payout_anomaly',
] as const

export type FinanceAlertKind = (typeof FINANCE_ALERT_KINDS)[number]

/** Cooldown table (ms). Source de vérité PRD-004 §4.15.7. */
const COOLDOWN_TABLE_MS: Record<FinanceAlertKind, number> = {
  finance_mismatch: 15 * 60_000,
  finance_stuck_authorization: 4 * 60 * 60_000,
  finance_stuck_captured_funds: 60 * 60_000,
  finance_transfer_pending: 30 * 60_000,
  finance_refund_mismatch: 15 * 60_000,
  finance_invariant_break: 60 * 60_000,
  finance_reconcile_failed: 30 * 60_000,
  finance_report_missing: 24 * 60 * 60_000,
  finance_payout_anomaly: 24 * 60 * 60_000,
}

export interface FinanceAlertPayload {
  kind: FinanceAlertKind
  severity: FinanceSeverity
  /** Scope cooldown (`mismatchType`, `kind` refund, `invariant`, `prestataireIdShort` etc.). Aucun PII. */
  cooldownScope?: string
  mismatchId?: string
  runId?: string
  context: Record<string, unknown>
}

@Injectable()
export class FinanceAlertingService {
  private readonly logger = new Logger(FinanceAlertingService.name)

  /** Map<`<kind>:<scope>`, lastEmittedAtMs>. */
  private readonly cooldownMap = new Map<string, number>()

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Émet une alerte. Retourne `{ emitted: true }` si l'alerte est sortie,
   * `{ emitted: false, reason: 'cooldown' }` sinon. Ne lève JAMAIS d'erreur
   * (les alerts ne doivent pas casser les schedulers — rule senior-dev §refus).
   */
  async emit(
    payload: FinanceAlertPayload,
  ): Promise<{ emitted: true; alertId: string } | { emitted: false; reason: 'cooldown' | 'invalid' }> {
    if (!FINANCE_ALERT_KINDS.includes(payload.kind)) {
      this.logger.error(`finance.alert.invalid_kind kind=${payload.kind}`)
      return { emitted: false, reason: 'invalid' }
    }

    if (
      !(FINANCE_METRIC_LABELS.severities as readonly string[]).includes(payload.severity)
    ) {
      this.logger.error(`finance.alert.invalid_severity severity=${payload.severity}`)
      return { emitted: false, reason: 'invalid' }
    }

    const cooldownKey = `${payload.kind}:${payload.cooldownScope ?? '_'}`
    const now = Date.now()
    const lastEmitted = this.cooldownMap.get(cooldownKey)
    const cooldownMs = COOLDOWN_TABLE_MS[payload.kind]

    if (lastEmitted !== undefined && now - lastEmitted < cooldownMs) {
      this.logger.debug(
        `finance.alert.cooldown kind=${payload.kind} scope=${payload.cooldownScope ?? '_'} elapsed_ms=${now - lastEmitted}`,
      )
      return { emitted: false, reason: 'cooldown' }
    }

    // Sanitization défensive — le caller doit déjà avoir whitelisté son
    // contexte via `sanitizeForFinanceSnapshot`, mais on re-deepSanitize pour
    // bloquer toute fuite (audit Verify V4).
    const safeContext = deepSanitize(payload.context)

    try {
      const alert = await this.prisma.financeAlert.create({
        data: {
          kind: payload.kind,
          severity: payload.severity,
          mismatchId: payload.mismatchId ?? null,
          runId: payload.runId ?? null,
          context: safeContext as object,
        },
        select: { id: true },
      })

      this.cooldownMap.set(cooldownKey, now)

      // Log structuré Pino. Le contexte est déjà sanitizé.
      this.logger.log({
        msg: `finance.alert.${payload.kind}`,
        severity: payload.severity,
        alertId: alert.id,
        mismatchId: payload.mismatchId ?? null,
        runId: payload.runId ?? null,
        cooldownScope: payload.cooldownScope ?? null,
        context: safeContext,
      })

      // TODO(debt): brancher `AlertingService` global (Discord/Resend) du
      // Ticket 4.1 Build B (PR #20) quand mergé en main. Pour MVP, le log
      // Pino + persistance DB + métrique Prometheus suffisent (CTO Ticket
      // 4.5 Design figé).

      return { emitted: true, alertId: alert.id }
    } catch (err) {
      this.logger.error(
        `finance.alert.persist_failed kind=${payload.kind} err=${err instanceof Error ? err.message : 'unknown'}`,
      )
      return { emitted: false, reason: 'invalid' }
    }
  }

  /**
   * @internal — usage tests uniquement. Reset l'état cooldown entre les suites.
   */
  __resetCooldownForTests(): void {
    this.cooldownMap.clear()
  }
}
