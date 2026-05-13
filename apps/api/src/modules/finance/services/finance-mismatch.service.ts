import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { FinanceMismatchStatus, Prisma } from '@prisma/client'

import { deepSanitize } from '../../../common/security/sanitize'
import { FinanceAlertingService, type FinanceAlertKind } from '../alerting/finance-alerting.service'
import {
  FINANCE_INVARIANT_CODES,
  FINANCE_MISMATCH_TRANSITIONS,
  type FinanceInvariantCode,
} from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import type { InvariantBreak } from '../invariants/invariant.contract'
import { FinanceMetricsTracker } from '../metrics/finance-metrics.tracker'

/**
 * PRD-004 Ticket 4.5 Build itération 2 — Service lifecycle `FinanceMismatch`
 * + persistance d'un `InvariantBreak` complet (DB + métrique + alerte).
 *
 * Source de vérité du mapping `mismatchCode → alert kind` :
 * la table ci-dessous (`CODE_TO_ALERT_KIND`) — figée, testée, auditable.
 *
 * Aucun PII : les snapshots sont déjà sanitisés par les invariants
 * (`sanitizeForFinanceSnapshot`). Le `context` envoyé à l'alerte est
 * additionnellement passé dans `deepSanitize` côté `FinanceAlertingService`.
 */
@Injectable()
export class FinanceMismatchService {
  private readonly logger = new Logger(FinanceMismatchService.name)

  constructor(
    private readonly repo: FinanceRepository,
    private readonly alerting: FinanceAlertingService,
    private readonly metrics: FinanceMetricsTracker,
  ) {}

  /** Vérifie que la transition `from → to` est autorisée. Lève 409 sinon. */
  assertTransitionAllowed(from: FinanceMismatchStatus, to: FinanceMismatchStatus): void {
    const allowed = (FINANCE_MISMATCH_TRANSITIONS[from] ?? []) as readonly string[]
    if (!allowed.includes(to)) {
      throw new HttpException(
        { error: 'FINANCE_MISMATCH_TRANSITION_INVALID', from, to, allowed },
        HttpStatus.CONFLICT,
      )
    }
  }

  async transition(args: {
    id: string
    status: FinanceMismatchStatus
    actorUserId: string
    notes?: string | null
  }): Promise<{ from: FinanceMismatchStatus; to: FinanceMismatchStatus; mismatchCode: string }> {
    const current = await this.repo.getMismatchStatus(args.id)
    if (!current) throw new NotFoundException({ error: 'FINANCE_MISMATCH_NOT_FOUND' })

    this.assertTransitionAllowed(current.status, args.status)

    if (
      (args.status === 'RESOLVED' || args.status === 'IGNORED') &&
      (!args.notes || args.notes.trim().length < 16)
    ) {
      throw new HttpException(
        { error: 'FINANCE_MISMATCH_NOTES_REQUIRED', minLength: 16 },
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.repo.updateMismatchStatus(args)
    this.logger.log(
      `finance.mismatch.transition id=${args.id} ${current.status}→${args.status} actor=${args.actorUserId} code=${current.mismatchCode}`,
    )
    return { from: current.status, to: args.status, mismatchCode: current.mismatchCode }
  }

  /**
   * Persiste un `InvariantBreak` détecté par un orchestrateur (reconcile / stuck
   * / invariants / payout anomaly). Pipeline :
   *   1. createMismatch (idempotent grâce à l'unique key (runId, code, kind, id))
   *   2. metricsTracker.recordMismatch + recordInvariantBreak / recordStuckFunds
   *      / recordRefundMismatch selon le code
   *   3. alertingService.emit (cooldown géré par le service)
   * Aucun throw — un échec d'alerte n'arrête pas la run.
   */
  async persist(args: {
    runId: string
    invariantBreak: InvariantBreak
  }): Promise<{ persisted: 'created' | 'duplicate'; alerted: boolean; alertId?: string }> {
    const ib = args.invariantBreak
    const created = await this.repo.createMismatch({
      runId: args.runId,
      mismatchCode: ib.mismatchCode,
      type: ib.mismatchType,
      resourceKind: ib.resourceKind,
      resourceId: ib.resourceId,
      severity: ib.severity,
      amountDeltaCents: ib.amountDeltaCents ?? null,
      dbSnapshot: ib.dbSnapshot as Prisma.InputJsonValue,
      stripeSnapshot: (ib.stripeSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
    })

    if (created === 'duplicate') {
      this.logger.debug(
        `finance.mismatch.duplicate runId=${args.runId} code=${ib.mismatchCode} resource=${ib.resourceKind}/${truncateId(ib.resourceId)}`,
      )
      return { persisted: 'duplicate', alerted: false }
    }

    this.metrics.recordMismatch({ type: ib.mismatchType, severity: ib.severity })
    if (ib.mismatchType === 'INVARIANT_SUM') {
      this.metrics.recordInvariantBreak(ib.mismatchCode)
    }
    if (ib.mismatchType === 'STUCK_AUTHORIZATION') {
      this.metrics.recordStuckFunds({ kind: 'AUTHORIZATION', totalAmountCents: 0 })
    }
    if (ib.mismatchType === 'STUCK_CAPTURED') {
      this.metrics.recordStuckFunds({ kind: 'CAPTURED', totalAmountCents: 0 })
    }
    if (ib.mismatchType === 'STUCK_PENDING') {
      this.metrics.recordTransferPending()
    }
    if (
      ib.mismatchCode === FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB
    ) {
      this.metrics.recordRefundMismatch('AMOUNT')
    }

    const kind = mapInvariantToAlertKind(ib.mismatchCode)
    const cooldownScope = mapInvariantToCooldownScope(ib)

    const alertOutcome = await this.alerting.emit({
      kind,
      severity: ib.severity,
      cooldownScope,
      mismatchId: created.id,
      runId: args.runId,
      context: deepSanitize({
        mismatchCode: ib.mismatchCode,
        mismatchType: ib.mismatchType,
        resourceKind: ib.resourceKind,
        resourceIdTruncated: truncateId(ib.resourceId),
        severity: ib.severity,
        amountDeltaCents: ib.amountDeltaCents ?? null,
        explanation: ib.explanation.slice(0, 500),
      }),
    })

    if (alertOutcome.emitted) {
      return { persisted: 'created', alerted: true, alertId: alertOutcome.alertId }
    }
    return { persisted: 'created', alerted: false }
  }
}

const CODE_TO_ALERT_KIND: Readonly<Record<FinanceInvariantCode, FinanceAlertKind>> = Object.freeze({
  [FINANCE_INVARIANT_CODES.CAPTURED_REQUIRES_AMOUNT]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.TRANSFER_SENT_IMPLIES_CAPTURED]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.TRANSFER_AMOUNT_EQUALS_PROVIDER_PAYOUT]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.REFUND_IMPLIES_CAPTURED_OR_REFUNDED]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.REFUND_AFTER_TRANSFER_NOT_AUTOMATIC]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.STRIPE_PI_AMOUNT_MATCHES_DB]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.STRIPE_TRANSFER_AMOUNT_MATCHES_DB]: 'finance_mismatch',
  [FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB]: 'finance_refund_mismatch',
  [FINANCE_INVARIANT_CODES.STUCK_AUTHORIZATION]: 'finance_stuck_authorization',
  [FINANCE_INVARIANT_CODES.STUCK_TRANSFER_PENDING]: 'finance_transfer_pending',
  [FINANCE_INVARIANT_CODES.STUCK_CAPTURED_WITHOUT_TRANSFER]: 'finance_stuck_captured_funds',
  [FINANCE_INVARIANT_CODES.DAILY_BALANCE]: 'finance_invariant_break',
})

function mapInvariantToAlertKind(code: FinanceInvariantCode): FinanceAlertKind {
  return CODE_TO_ALERT_KIND[code]
}

/**
 * Cooldown scope :
 *  - `finance_mismatch` ............ scope = mismatchType (AMOUNT/STATUS/...)
 *  - `finance_refund_mismatch` ..... scope = `AMOUNT` (kind unique en MVP)
 *  - `finance_stuck_*` ............. scope = resourceIdTruncated (par ressource)
 *  - `finance_transfer_pending` .... scope = "_" (batch)
 *  - `finance_invariant_break` ..... scope = mismatchCode (`FIN-J-001`)
 */
function mapInvariantToCooldownScope(ib: InvariantBreak): string {
  if (ib.mismatchType === 'INVARIANT_SUM') return ib.mismatchCode
  if (ib.mismatchType === 'STUCK_AUTHORIZATION' || ib.mismatchType === 'STUCK_CAPTURED') {
    return truncateId(ib.resourceId)
  }
  if (ib.mismatchType === 'STUCK_PENDING') return '_'
  if (ib.mismatchCode === FINANCE_INVARIANT_CODES.STRIPE_REFUND_AMOUNT_MATCHES_DB) return 'AMOUNT'
  return ib.mismatchType
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id
}
