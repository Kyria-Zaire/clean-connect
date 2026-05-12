/**
 * BullMqMetricsService — observe les queues BullMQ via QueueEvents Redis pubsub
 * (PRD-004 Ticket 4.1 — Build A3).
 *
 * Au boot, attache un `QueueEvents` par queue trackée. Aucune modification
 * des processors existants n'est nécessaire : Redis broadcaste les events
 * `completed` / `failed` globalement.
 *
 * Métriques alimentées :
 * - `cleanconnect_bullmq_jobs_total{queue,name,result}` (counter)
 * - `cleanconnect_bullmq_jobs_failed_total{queue,name,reason}` (counter)
 * - `cleanconnect_dlq_jobs_total{queue}` (gauge — refresh on `failed`)
 *
 * Labels :
 * - `name` = job name (`stripe.evt.processed`, `auto-release.tx`, etc.).
 *   Cardinalité bornée par le nombre de noms de jobs définis dans le code.
 * - `reason` = code court (`worker_error`, `stalled`, `timeout`) — pas le
 *   message brut (cardinalité). Si `failedReason` est long, on tronque à
 *   un slug stable.
 *
 * Aucune PII dans les labels (job IDs / payloads jamais utilisés).
 */

import { type OnModuleDestroy, type OnModuleInit, Injectable, Logger } from '@nestjs/common'
import { Queue, QueueEvents } from 'bullmq'

import { loadEnv } from '../../../common/config/env'
import { AUTO_RELEASE_QUEUE } from '../../missions-completion/auto-release/auto-release.constants'
import { STRIPE_WEBHOOK_QUEUE } from '../../payments/payments.constants'

import { MetricsService } from './metrics.service'

/**
 * Liste statique des queues à monitorer. Ajouter ici toute nouvelle queue
 * BullMQ enregistrée dans un module — la mise à jour des compteurs sera
 * automatique grâce à `QueueEvents`.
 */
const TRACKED_QUEUES = [STRIPE_WEBHOOK_QUEUE, AUTO_RELEASE_QUEUE] as const

/**
 * Slugs de raisons normalisées. Tout autre `failedReason` est tronqué à
 * `unknown` pour borner la cardinalité de `reason`.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'worker_error',
  'stalled',
  'timeout',
  'unhandled',
  'retries_exhausted',
])

@Injectable()
export class BullMqMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMqMetricsService.name)
  private readonly queueEvents: QueueEvents[] = []
  private readonly queueProbes: Queue[] = []

  constructor(private readonly metrics: MetricsService) {}

  async onModuleInit(): Promise<void> {
    const env = loadEnv()
    const url = new URL(env.REDIS_URL)
    const connection = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      password: url.password || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    } as const
    const prefix = `cc:${env.APP_ENV}`

    for (const queueName of TRACKED_QUEUES) {
      const events = new QueueEvents(queueName, { connection, prefix })
      const queue = new Queue(queueName, { connection, prefix })

      events.on('completed', ({ jobId }) => {
        void this.tagOnCompleted(queue, jobId)
      })

      events.on('failed', ({ jobId, failedReason }) => {
        void this.tagOnFailed(queue, jobId, failedReason)
      })

      // `error` ne touche pas la métrique business — on log juste pour debug.
      events.on('error', (err) => {
        this.logger.warn({ queue: queueName, err: String(err) }, 'bullmq queue events error')
      })

      this.queueEvents.push(events)
      this.queueProbes.push(queue)
    }

    this.logger.log({ queues: [...TRACKED_QUEUES] }, 'bullmq metrics listener wired')
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      ...this.queueEvents.map((e) => e.close()),
      ...this.queueProbes.map((q) => q.close()),
    ])
  }

  private async tagOnCompleted(queue: Queue, jobId: string): Promise<void> {
    const name = await this.safeJobName(queue, jobId)
    this.metrics.bullmqJobsTotal.inc({ queue: queue.name, name, result: 'success' })
  }

  private async tagOnFailed(queue: Queue, jobId: string, failedReason?: string): Promise<void> {
    const name = await this.safeJobName(queue, jobId)
    const reason = normalizeReason(failedReason)
    this.metrics.bullmqJobsTotal.inc({ queue: queue.name, name, result: 'failure' })
    this.metrics.bullmqJobsFailedTotal.inc({ queue: queue.name, name, reason })

    // Refresh DLQ gauge — count des jobs en état failed à l'instant.
    try {
      const failedCount = await queue.getFailedCount()
      this.metrics.dlqJobsTotal.set({ queue: queue.name }, failedCount)
    } catch (err) {
      this.logger.warn(
        { queue: queue.name, err: String(err) },
        'bullmq dlq gauge refresh failed',
      )
    }
  }

  private async safeJobName(queue: Queue, jobId: string): Promise<string> {
    try {
      const job = await queue.getJob(jobId)
      return job?.name ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

export function normalizeReason(raw: string | undefined): string {
  if (!raw) return 'unknown'
  const lower = raw.toLowerCase()
  for (const slug of KNOWN_REASONS) {
    if (lower.includes(slug.replace(/_/g, ' ')) || lower.includes(slug)) return slug
  }
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout'
  if (lower.includes('stalled')) return 'stalled'
  if (lower.includes('retries')) return 'retries_exhausted'
  return 'unknown'
}
