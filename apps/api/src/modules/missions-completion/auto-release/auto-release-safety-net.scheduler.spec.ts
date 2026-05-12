/**
 * PRD-004 Ticket 4.2 — Tests unitaires `AutoReleaseSafetyNetScheduler`.
 *
 * Couverture :
 *  - tick déclenche `autoRelease.reenqueueStuck` avec `now` propagé
 *  - aucune alerte sous le threshold
 *  - alerte P1 `auto_release_stalled` au-dessus du threshold
 *  - résultat propagé tel quel au caller
 *  - swallow errors d'`alerting.emit` (jamais throw)
 */

import type { AlertingService } from '../../observability/alerting/alerting.service'
import type { AlertPayload } from '../../observability/alerting/alerting.types'

import {
  AutoReleaseSafetyNetScheduler,
  AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD,
} from './auto-release-safety-net.scheduler'
import type { AutoReleaseService } from './auto-release.service'

interface FakeAutoReleaseService {
  reenqueueStuck: jest.Mock
}

interface FakeAlertingService {
  emit: jest.Mock
  lastCalls: AlertPayload[]
}

function makeFakes(): {
  scheduler: AutoReleaseSafetyNetScheduler
  autoRelease: FakeAutoReleaseService
  alerting: FakeAlertingService
} {
  const autoRelease: FakeAutoReleaseService = {
    reenqueueStuck: jest.fn(),
  }
  const lastCalls: AlertPayload[] = []
  const alerting: FakeAlertingService = {
    emit: jest.fn(async (p: AlertPayload) => {
      lastCalls.push(p)
    }),
    lastCalls,
  }
  const scheduler = new AutoReleaseSafetyNetScheduler(
    autoRelease as unknown as AutoReleaseService,
    alerting as unknown as AlertingService,
  )
  return { scheduler, autoRelease, alerting }
}

describe('AutoReleaseSafetyNetScheduler', () => {
  it('delegates to autoRelease.reenqueueStuck and returns the result', async () => {
    const { scheduler, autoRelease } = makeFakes()
    autoRelease.reenqueueStuck.mockResolvedValueOnce({
      scanned: 3,
      relockReleased: 1,
      reenqueued: 2,
    })
    const now = new Date('2026-05-13T01:00:00Z')
    const result = await scheduler.tickInternal(now)
    expect(autoRelease.reenqueueStuck).toHaveBeenCalledWith({ now })
    expect(result).toEqual({ scanned: 3, relockReleased: 1, reenqueued: 2 })
  })

  it('does NOT emit alert when reenqueued < threshold', async () => {
    const { scheduler, autoRelease, alerting } = makeFakes()
    autoRelease.reenqueueStuck.mockResolvedValueOnce({
      scanned: 2,
      relockReleased: 0,
      reenqueued: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD - 1,
    })
    await scheduler.tickInternal(new Date())
    expect(alerting.emit).not.toHaveBeenCalled()
  })

  it('emits P1 auto_release_stalled when reenqueued >= threshold', async () => {
    const { scheduler, autoRelease, alerting } = makeFakes()
    autoRelease.reenqueueStuck.mockResolvedValueOnce({
      scanned: 50,
      relockReleased: 5,
      reenqueued: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD + 3,
    })
    await scheduler.tickInternal(new Date())
    expect(alerting.emit).toHaveBeenCalledTimes(1)
    const alert = alerting.lastCalls[0]!
    expect(alert.severity).toBe('P1')
    expect(alert.kind).toBe('auto_release_stalled')
    expect(alert.title).toContain(`${AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD + 3}`)
    expect(alert.context).toMatchObject({
      reenqueued: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD + 3,
      threshold: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD,
    })
    // No PII (mission/user IDs) in alert context.
    const json = JSON.stringify(alert)
    expect(json).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-/i)
  })

  it('emits exactly at the threshold value', async () => {
    const { scheduler, autoRelease, alerting } = makeFakes()
    autoRelease.reenqueueStuck.mockResolvedValueOnce({
      scanned: 10,
      relockReleased: 0,
      reenqueued: AUTO_RELEASE_SAFETY_ANOMALY_THRESHOLD,
    })
    await scheduler.tickInternal(new Date())
    expect(alerting.emit).toHaveBeenCalledTimes(1)
  })

  it('propagates reenqueueStuck rejection (caller decides retry policy)', async () => {
    const { scheduler, autoRelease } = makeFakes()
    autoRelease.reenqueueStuck.mockRejectedValueOnce(new Error('db_down'))
    await expect(scheduler.tickInternal(new Date())).rejects.toThrow('db_down')
  })

  it('runHourlySafetyNet invokes tickInternal with current Date', async () => {
    const { scheduler, autoRelease, alerting } = makeFakes()
    autoRelease.reenqueueStuck.mockResolvedValueOnce({
      scanned: 0,
      relockReleased: 0,
      reenqueued: 0,
    })
    await scheduler.runHourlySafetyNet()
    expect(autoRelease.reenqueueStuck).toHaveBeenCalledTimes(1)
    expect(alerting.emit).not.toHaveBeenCalled()
  })
})
