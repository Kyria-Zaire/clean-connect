/**
 * PRD-004 Ticket 4.2 — Tests unitaires `AutoReleaseService.reenqueueStuck`.
 *
 * Couverture :
 *  - SCHEDULED overdue → re-enqueue BullMQ
 *  - RUNNING avec lock orphelin → release lock + re-enqueue
 *  - Mix : compteurs incrémentés correctement
 *  - `releaseStuckLockTx` retourne 0 (race) → skip + log
 *  - Errors `enqueueDelayedJob` ne cassent pas la boucle
 *  - Aucun job stuck → no-op safe
 */

import type { AutoReleaseJob, Prisma } from '@prisma/client'

import type { PrismaService } from '../../../common/prisma/prisma.service'

import type { AutoReleaseJobRepository } from './auto-release.repository'
import { AutoReleaseService, type AutoReleaseJobPayload } from './auto-release.service'

interface FakeQueue {
  add: jest.Mock
}

interface FakePrisma {
  $transaction: jest.Mock
}

interface FakeJobsRepo {
  findStuckJobs: jest.Mock
  releaseStuckLockTx: jest.Mock
  upsertScheduledTx: jest.Mock
  cancelTx: jest.Mock
}

function makeService(): {
  service: AutoReleaseService
  prisma: FakePrisma
  jobs: FakeJobsRepo
  queue: FakeQueue
} {
  const queue: FakeQueue = { add: jest.fn(async () => ({})) }
  const jobs: FakeJobsRepo = {
    findStuckJobs: jest.fn(),
    releaseStuckLockTx: jest.fn(),
    upsertScheduledTx: jest.fn(),
    cancelTx: jest.fn(),
  }
  const prisma: FakePrisma = {
    $transaction: jest.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      // On passe un faux tx — le mock `jobs` ne s'en sert pas.
      return fn({} as Prisma.TransactionClient)
    }),
  }
  // Le 3e paramètre du ctor est `@InjectQueue(AUTO_RELEASE_QUEUE) Queue` —
  // typage Bull complexe, mais le service ne s'en sert que via `add()` et
  // `getJob().remove()`. On caste donc en `never` côté ctor — `as unknown`
  // est strictement nécessaire ici (mock du runtime DI Nest).
  const ServiceCtor = AutoReleaseService as unknown as new (
    p: PrismaService,
    j: AutoReleaseJobRepository,
    q: FakeQueue,
  ) => AutoReleaseService
  const service = new ServiceCtor(
    prisma as unknown as PrismaService,
    jobs as unknown as AutoReleaseJobRepository,
    queue,
  )
  return { service, prisma, jobs, queue }
}

// Helper pour fabriquer un AutoReleaseJob mocké.
function makeJob(overrides: Partial<AutoReleaseJob> = {}): AutoReleaseJob {
  return {
    id: 'job-1',
    missionId: 'mission-1',
    bullJobId: 'auto-release-mission-mission-1',
    idempotencyKey: 'capture-mission-mission-1',
    scheduledFor: new Date('2026-05-12T00:00:00Z'),
    status: 'SCHEDULED',
    lockedAt: null,
    lockedBy: null,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    lastError: null,
    cancelReason: null,
    createdAt: new Date('2026-05-10T00:00:00Z'),
    updatedAt: new Date('2026-05-12T00:00:00Z'),
    ...overrides,
  } as AutoReleaseJob
}

describe('AutoReleaseService.reenqueueStuck', () => {
  const NOW = new Date('2026-05-13T00:00:00Z')

  it('returns zero counters when no stuck jobs', async () => {
    const { service, jobs, queue } = makeService()
    jobs.findStuckJobs.mockResolvedValueOnce([])
    const r = await service.reenqueueStuck({ now: NOW })
    expect(r).toEqual({ scanned: 0, relockReleased: 0, reenqueued: 0 })
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('re-enqueues SCHEDULED overdue jobs without touching the lock', async () => {
    const { service, jobs, queue } = makeService()
    jobs.findStuckJobs.mockResolvedValueOnce([
      makeJob({ id: 'j-1', missionId: 'm-1', status: 'SCHEDULED' }),
      makeJob({ id: 'j-2', missionId: 'm-2', status: 'SCHEDULED' }),
    ])
    const r = await service.reenqueueStuck({ now: NOW })
    expect(jobs.releaseStuckLockTx).not.toHaveBeenCalled()
    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ scanned: 2, relockReleased: 0, reenqueued: 2 })
  })

  it('releases orphan lock for RUNNING jobs before re-enqueue', async () => {
    const { service, jobs, queue } = makeService()
    jobs.findStuckJobs.mockResolvedValueOnce([
      makeJob({ id: 'j-stuck', missionId: 'm-3', status: 'RUNNING', lockedAt: new Date('2026-05-12T22:00:00Z'), lockedBy: 'worker-A' }),
    ])
    jobs.releaseStuckLockTx.mockResolvedValueOnce(1)
    const r = await service.reenqueueStuck({ now: NOW })
    expect(jobs.releaseStuckLockTx).toHaveBeenCalledTimes(1)
    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ scanned: 1, relockReleased: 1, reenqueued: 1 })
  })

  it('skips RUNNING job when lock release returns 0 (race with worker recovery)', async () => {
    const { service, jobs, queue } = makeService()
    jobs.findStuckJobs.mockResolvedValueOnce([
      makeJob({ id: 'j-race', missionId: 'm-4', status: 'RUNNING', lockedAt: new Date('2026-05-12T22:00:00Z') }),
    ])
    jobs.releaseStuckLockTx.mockResolvedValueOnce(0)
    const r = await service.reenqueueStuck({ now: NOW })
    expect(queue.add).not.toHaveBeenCalled()
    expect(r).toEqual({ scanned: 1, relockReleased: 0, reenqueued: 0 })
  })

  it('continues loop on enqueueDelayedJob throw (cron resilience)', async () => {
    const { service, jobs, queue } = makeService()
    queue.add.mockRejectedValueOnce(new Error('redis_down'))
    jobs.findStuckJobs.mockResolvedValueOnce([
      makeJob({ id: 'j-1', missionId: 'm-1' }),
      makeJob({ id: 'j-2', missionId: 'm-2' }),
    ])
    const r = await service.reenqueueStuck({ now: NOW })
    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ scanned: 2, relockReleased: 0, reenqueued: 1 })
  })

  it('payload passed to queue.add contains only autoReleaseJobId + missionId (no PII)', async () => {
    const { service, jobs, queue } = makeService()
    jobs.findStuckJobs.mockResolvedValueOnce([
      makeJob({ id: 'job-uuid', missionId: 'mission-uuid' }),
    ])
    await service.reenqueueStuck({ now: NOW })
    const payload = queue.add.mock.calls[0]![1] as AutoReleaseJobPayload & {
      _otel?: unknown
    }
    const allowed = new Set(['autoReleaseJobId', 'missionId', '_otel'])
    for (const k of Object.keys(payload)) {
      expect(allowed.has(k)).toBe(true)
    }
    expect(payload.autoReleaseJobId).toBe('job-uuid')
    expect(payload.missionId).toBe('mission-uuid')
  })
})
