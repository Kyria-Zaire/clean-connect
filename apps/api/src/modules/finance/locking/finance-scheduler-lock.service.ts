/**
 * PRD-004 Ticket 4.5 — `FinanceSchedulerLockService` (CTO ajustement obligatoire).
 *
 * Verrou anti-overlap pour les schedulers finance. Ajustement CTO Build :
 *  > "lock Redis ou DB / un seul run actif par scheduler / expiration du lock
 *  > obligatoire / aucun doublon FinanceReconciliationRun".
 *
 * **Choix DB** :
 *  - Pas de nouvelle dépendance Redis (BullMQ existant n'est pas exposé en
 *    "raw redis"). Une table `finance_scheduler_locks` dédiée fournit :
 *    1. **Acquire idempotent** : `INSERT … ON CONFLICT (key) DO UPDATE SET …
 *       WHERE expires_at < NOW()` — l'UPDATE n'a lieu QUE si le lock courant
 *       est expiré (aucun race two-active-runs).
 *    2. **Auto-cleanup** : un worker qui crash sans `release` ⇒ le lock expire
 *       seul après TTL.
 *    3. **Auditabilité** : `acquired_at` / `expires_at` / `owner` consultables
 *       en SQL pour le forensic post-mortem.
 *
 * Le mécanisme repose sur `$executeRaw` (Prisma 5 sait re-traduire les params)
 * — c'est l'un des rares endroits où l'on s'autorise du SQL brut, justifié
 * par l'atomicité requise.
 *
 * Pas de retry interne — `withLock(...)` retourne `'busy'` si le lock est
 * déjà détenu, et le caller décide quoi faire (log + skip pour les @Cron).
 *
 * Fail-open Redis interdit : on est ici fail-closed (si DB down, on log et
 * on skip — comme tout le reste du système si la DB est down).
 */

import { randomUUID } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../../common/prisma/prisma.service'
import type { FinanceLockKey } from '../finance.constants'

export interface FinanceLockHandle {
  readonly key: FinanceLockKey
  readonly owner: string
  readonly acquiredAt: Date
  readonly expiresAt: Date
}

export type FinanceLockOutcome<T> = { acquired: true; result: T } | { acquired: false; reason: 'busy' }

@Injectable()
export class FinanceSchedulerLockService {
  private readonly logger = new Logger(FinanceSchedulerLockService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tente d'acquérir le lock. Retourne `null` si déjà détenu ET non expiré.
   *
   * SQL atomique :
   *   INSERT INTO finance_scheduler_locks (key, owner, acquired_at, expires_at)
   *   VALUES (key, owner, now, expires)
   *   ON CONFLICT (key) DO UPDATE
   *     SET owner = EXCLUDED.owner,
   *         acquired_at = EXCLUDED.acquired_at,
   *         expires_at = EXCLUDED.expires_at
   *     WHERE finance_scheduler_locks.expires_at < EXCLUDED.acquired_at;
   *
   * Le `WHERE` côté `DO UPDATE` empêche le takeover d'un lock encore vivant.
   * Si l'INSERT initial réussit (pas de conflit) ⇒ on a le lock.
   * Si le conflit avec UPDATE-NoOp (lock vivant) ⇒ 0 row affected.
   * Si le conflit avec UPDATE-applied (lock expiré) ⇒ 1 row affected.
   */
  async tryAcquire(key: FinanceLockKey, ttlMs: number): Promise<FinanceLockHandle | null> {
    if (ttlMs <= 0) throw new Error('finance-lock: ttlMs must be > 0')

    const owner = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs)

    const affected = await this.prisma.$executeRaw`
      INSERT INTO finance_scheduler_locks (key, owner, acquired_at, expires_at)
      VALUES (${key}, ${owner}, ${now}, ${expiresAt})
      ON CONFLICT (key) DO UPDATE
        SET owner = EXCLUDED.owner,
            acquired_at = EXCLUDED.acquired_at,
            expires_at = EXCLUDED.expires_at
        WHERE finance_scheduler_locks.expires_at < EXCLUDED.acquired_at
    `

    if (affected === 0) {
      this.logger.warn(`finance-lock.acquire.busy key=${key}`)
      return null
    }

    return { key, owner, acquiredAt: now, expiresAt }
  }

  /**
   * Libère le lock si on en est toujours propriétaire (`owner` match). Si un
   * lock a expiré et a été pris par un autre worker, on **n'écrase pas** le
   * nouveau propriétaire — c'est le sens du filtre `WHERE owner = ?`.
   */
  async release(handle: FinanceLockHandle): Promise<void> {
    const affected = await this.prisma.$executeRaw`
      DELETE FROM finance_scheduler_locks
      WHERE key = ${handle.key}
        AND owner = ${handle.owner}
    `
    if (affected === 0) {
      this.logger.warn(
        `finance-lock.release.stale key=${handle.key} (lock already taken over or expired)`,
      )
    }
  }

  /**
   * Helper "run-with-lock" — acquiert, exécute, libère (avec finally pour
   * couvrir l'exception du callback). Si le lock est busy, retourne
   * `{ acquired: false, reason: 'busy' }`. Le caller (scheduler) log + skip.
   */
  async withLock<T>(
    key: FinanceLockKey,
    ttlMs: number,
    fn: (handle: FinanceLockHandle) => Promise<T>,
  ): Promise<FinanceLockOutcome<T>> {
    const handle = await this.tryAcquire(key, ttlMs)
    if (!handle) return { acquired: false, reason: 'busy' }

    try {
      const result = await fn(handle)
      return { acquired: true, result }
    } finally {
      await this.release(handle).catch((err) => {
        // Pas de catch silencieux — on log mais on ne propage pas pour ne pas
        // masquer une éventuelle exception du callback (fn).
        this.logger.error(
          `finance-lock.release.error key=${key} owner=${handle.owner} err=${err instanceof Error ? err.message : 'unknown'}`,
        )
      })
    }
  }
}
