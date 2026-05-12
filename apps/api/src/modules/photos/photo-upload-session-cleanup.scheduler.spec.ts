/**
 * PRD-004 Ticket 4.2 — Tests unitaires `PhotoUploadSessionCleanupScheduler`.
 *
 * Couverture :
 *  - propage `olderThan = now - buffer` au repository
 *  - propage `limit`
 *  - retourne le nombre de lignes supprimées
 *  - runDailyCleanup invoque tickInternal avec un Date proche du now actuel
 *  - propage les exceptions repository (caller / cron decide)
 */

import {
  PHOTO_SESSION_CLEANUP_BUFFER_MS,
  PHOTO_SESSION_CLEANUP_LIMIT,
  PhotoUploadSessionCleanupScheduler,
} from './photo-upload-session-cleanup.scheduler'
import type { PhotosRepository } from './photos.repository'

interface FakeRepo {
  deleteExpiredUnconsumedSessions: jest.Mock
}

function makeScheduler(): { scheduler: PhotoUploadSessionCleanupScheduler; repo: FakeRepo } {
  const repo: FakeRepo = {
    deleteExpiredUnconsumedSessions: jest.fn(),
  }
  const scheduler = new PhotoUploadSessionCleanupScheduler(repo as unknown as PhotosRepository)
  return { scheduler, repo }
}

describe('PhotoUploadSessionCleanupScheduler', () => {
  it('computes olderThan = now - BUFFER and passes LIMIT', async () => {
    const { scheduler, repo } = makeScheduler()
    repo.deleteExpiredUnconsumedSessions.mockResolvedValueOnce(7)
    const now = new Date('2026-05-13T04:15:00Z')
    const result = await scheduler.tickInternal(now)

    expect(result).toEqual({ deleted: 7 })
    expect(repo.deleteExpiredUnconsumedSessions).toHaveBeenCalledTimes(1)
    const args = repo.deleteExpiredUnconsumedSessions.mock.calls[0]![0] as {
      olderThan: Date
      limit: number
    }
    expect(args.limit).toBe(PHOTO_SESSION_CLEANUP_LIMIT)
    expect(args.olderThan.getTime()).toBe(now.getTime() - PHOTO_SESSION_CLEANUP_BUFFER_MS)
  })

  it('returns 0 when nothing to delete', async () => {
    const { scheduler, repo } = makeScheduler()
    repo.deleteExpiredUnconsumedSessions.mockResolvedValueOnce(0)
    const result = await scheduler.tickInternal(new Date())
    expect(result).toEqual({ deleted: 0 })
  })

  it('runDailyCleanup delegates to tickInternal with new Date()', async () => {
    const { scheduler, repo } = makeScheduler()
    repo.deleteExpiredUnconsumedSessions.mockResolvedValueOnce(3)
    const before = Date.now()
    await scheduler.runDailyCleanup()
    const after = Date.now()
    expect(repo.deleteExpiredUnconsumedSessions).toHaveBeenCalledTimes(1)
    const callTime = (repo.deleteExpiredUnconsumedSessions.mock.calls[0]![0] as { olderThan: Date })
      .olderThan.getTime()
    // olderThan = now - BUFFER ; donc now ≈ olderThan + BUFFER ∈ [before, after]
    expect(callTime + PHOTO_SESSION_CLEANUP_BUFFER_MS).toBeGreaterThanOrEqual(before)
    expect(callTime + PHOTO_SESSION_CLEANUP_BUFFER_MS).toBeLessThanOrEqual(after)
  })

  it('propagates repository errors (cron framework decides retry)', async () => {
    const { scheduler, repo } = makeScheduler()
    repo.deleteExpiredUnconsumedSessions.mockRejectedValueOnce(new Error('db_down'))
    await expect(scheduler.tickInternal(new Date())).rejects.toThrow('db_down')
  })

  it('BUFFER and LIMIT are exposed as documented constants', () => {
    expect(PHOTO_SESSION_CLEANUP_BUFFER_MS).toBe(60 * 60 * 1_000)
    expect(PHOTO_SESSION_CLEANUP_LIMIT).toBe(500)
  })
})
