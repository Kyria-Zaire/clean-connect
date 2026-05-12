/**
 * PRD-003 Ticket 3.4 — tests unitaires `AutoReleaseExecutor`.
 *
 * Couverture obligatoire :
 *  1. Skip si job introuvable (race rejouée DLQ Ticket 3.5).
 *  2. Skip si job terminal (CANCELLED / COMPLETED / FAILED).
 *  3. Skip si verrou non acquis (worker concurrent ou job déjà cancellé).
 *  4. Blocked si mission != CLIENT_VALIDATION_PENDING (DISPUTE_OPEN / COMPLETED).
 *  5. Blocked si payment != AUTHORIZED (authorization_expired).
 *  6. Blocked si quotas photos insuffisants.
 *  7. Happy path → capture Stripe SYSTEM/AUTO_RELEASE + markCompleted +
 *     audit AUTO_RELEASE_STARTED + AUTO_RELEASE_TRIGGERED.
 *  8. PaymentNotCapturable côté capture → BLOCKED, pas FAILED (retry inutile).
 *  9. Erreur Stripe réseau → FAILED + re-throw (retry BullMQ).
 */

import type { AutoReleaseJob, Mission, Payment, Prisma } from '@prisma/client'

import type { PrismaService } from '../../../common/prisma/prisma.service'
import type { MissionsRepository } from '../../missions/missions.repository'
import type { MissionEventService } from '../../missions/services/mission-event.service'
import {
  PaymentAuthorizationExpiredException,
  PaymentNotCapturableException,
} from '../../payments/payments.errors'
import type { PaymentsRepository } from '../../payments/payments.repository'
import type { PaymentsService } from '../../payments/payments.service'
import type { MissionPhotoQuotaService } from '../photo-quota.service'

import { AutoReleaseExecutor } from './auto-release.executor'
import type { AutoReleaseJobRepository } from './auto-release.repository'

const MISSION_ID = '00000000-0000-4000-8000-000000000001'
const JOB_ID = '00000000-0000-4000-8000-0000000000cc'
const WORKER_ID = 'test-worker#1'

function buildJob(overrides: Partial<AutoReleaseJob> = {}): AutoReleaseJob {
  return {
    id: JOB_ID,
    missionId: MISSION_ID,
    scheduledFor: new Date('2026-06-03T10:00:00Z'),
    status: 'SCHEDULED',
    bullJobId: `auto-release-mission-${MISSION_ID}`,
    idempotencyKey: `capture-mission-${MISSION_ID}`,
    cancelReason: null,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-06-01T10:00:00Z'),
    updatedAt: new Date('2026-06-01T10:00:00Z'),
    ...overrides,
  }
}

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    missionNumber: 'CC-2026-000001',
    status: 'CLIENT_VALIDATION_PENDING',
    serviceType: 'SOFA',
    clientId: '00000000-0000-4000-8000-0000000000aa',
    prestataireId: '00000000-0000-4000-8000-0000000000bb',
    addressId: '00000000-0000-4000-8000-0000000000dd',
    startAt: new Date('2026-06-01T10:00:00Z'),
    endAt: new Date('2026-06-01T12:00:00Z'),
    timeZone: 'Europe/Paris',
    isAsap: false,
    estimatedPriceCents: 12_000,
    publishedAt: null,
    listingExpiresAt: null,
    createdAt: new Date('2026-05-20T08:00:00Z'),
    updatedAt: new Date('2026-05-20T08:00:00Z'),
    ...overrides,
  }
}

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '00000000-0000-4000-8000-000000000999',
    missionId: MISSION_ID,
    stripePaymentIntentId: 'pi_unit_001',
    idempotencyKey: 'cc-test-idempotency-key-1234',
    amountAuthorizedCents: 12_000,
    amountCapturedCents: null,
    currency: 'eur',
    applicationFeeCents: 2_160,
    providerPayoutCents: 9_840,
    vatRateSnapshot: null,
    status: 'AUTHORIZED',
    failureCode: null,
    failureMessage: null,
    createdAt: new Date('2026-05-20T08:00:00Z'),
    updatedAt: new Date('2026-05-20T08:00:00Z'),
    ...overrides,
  }
}

interface Harness {
  executor: AutoReleaseExecutor
  jobs: {
    findById: jest.Mock
    tryAcquireLockTx: jest.Mock
    markCompletedTx: jest.Mock
    markFailedTx: jest.Mock
  }
  missions: { findById: jest.Mock }
  payments: { findByMissionId: jest.Mock }
  photoQuota: { check: jest.Mock }
  paymentsService: { requestCapture: jest.Mock }
  events: { record: jest.Mock; recordTx: jest.Mock }
}

function buildHarness(overrides: {
  job?: AutoReleaseJob | null
  lockResult?: number
  mission?: Mission | null
  payment?: Payment | null
  quotas?: { isComplete: boolean }
} = {}): Harness {
  const jobs = {
    findById: jest.fn().mockResolvedValue(overrides.job === undefined ? buildJob() : overrides.job),
    tryAcquireLockTx: jest.fn().mockResolvedValue(overrides.lockResult ?? 1),
    markCompletedTx: jest.fn().mockResolvedValue(1),
    markFailedTx: jest.fn().mockResolvedValue(1),
  }
  const missions = {
    findById: jest
      .fn()
      .mockResolvedValue(overrides.mission === undefined ? buildMission() : overrides.mission),
  }
  const payments = {
    findByMissionId: jest
      .fn()
      .mockResolvedValue(overrides.payment === undefined ? buildPayment() : overrides.payment),
  }
  const photoQuota = {
    check: jest.fn().mockResolvedValue(overrides.quotas ?? { isComplete: true, reason: 'OK', beforeCount: 3, afterCount: 5 }),
  }
  const paymentsService = {
    requestCapture: jest.fn().mockResolvedValue({ status: 'AUTHORIZED' }),
  }
  const events = {
    record: jest.fn().mockResolvedValue(undefined),
    recordTx: jest.fn().mockResolvedValue(undefined),
  }
  const prismaTransaction = jest
    .fn()
    .mockImplementation(async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb({} as unknown as Prisma.TransactionClient),
    )
  const prisma = { $transaction: prismaTransaction } as unknown as PrismaService

  const executor = new AutoReleaseExecutor(
    prisma,
    jobs as unknown as AutoReleaseJobRepository,
    missions as unknown as MissionsRepository,
    payments as unknown as PaymentsRepository,
    events as unknown as MissionEventService,
    photoQuota as unknown as MissionPhotoQuotaService,
    paymentsService as unknown as PaymentsService,
  )

  return { executor, jobs, missions, payments, photoQuota, paymentsService, events }
}

describe('AutoReleaseExecutor (PRD-003 Ticket 3.4)', () => {
  it('skip JOB_NOT_FOUND si la ligne AutoReleaseJob est introuvable', async () => {
    const { executor } = buildHarness({ job: null })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('SKIPPED')
    expect(result.reason).toBe('JOB_NOT_FOUND')
  })

  it('skip JOB_TERMINAL si status=CANCELLED', async () => {
    const { executor, jobs } = buildHarness({ job: buildJob({ status: 'CANCELLED' }) })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('SKIPPED')
    expect(result.reason).toBe('JOB_TERMINAL')
    expect(jobs.tryAcquireLockTx).not.toHaveBeenCalled()
  })

  it('skip LOCK_NOT_ACQUIRED si tryAcquireLockTx renvoie 0 (worker concurrent)', async () => {
    const { executor, paymentsService } = buildHarness({ lockResult: 0 })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('SKIPPED')
    expect(result.reason).toBe('LOCK_NOT_ACQUIRED')
    expect(paymentsService.requestCapture).not.toHaveBeenCalled()
  })

  it('blocked si mission != CLIENT_VALIDATION_PENDING (DISPUTE_OPEN par exemple)', async () => {
    const { executor, paymentsService, events } = buildHarness({
      mission: buildMission({ status: 'DISPUTE_OPEN' }),
    })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).toBe('MISSION_STATE_NOT_CLIENT_VALIDATION_PENDING')
    expect(paymentsService.requestCapture).not.toHaveBeenCalled()

    const blockedAudit = events.recordTx.mock.calls.find(
      (call) => (call[1] as { type: string }).type === 'AUTO_RELEASE_BLOCKED',
    )
    expect(blockedAudit).toBeDefined()
  })

  it('blocked PAYMENT_AUTHORIZATION_EXPIRED si payment CANCELLED + failureCode=authorization_expired', async () => {
    const { executor, paymentsService } = buildHarness({
      payment: buildPayment({ status: 'CANCELLED', failureCode: 'authorization_expired' }),
    })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).toBe('PAYMENT_AUTHORIZATION_EXPIRED')
    expect(paymentsService.requestCapture).not.toHaveBeenCalled()
  })

  it('blocked PHOTOS_INSUFFICIENT si quotas pas atteints', async () => {
    const { executor, paymentsService } = buildHarness({
      quotas: { isComplete: false },
    })
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).toBe('PHOTOS_INSUFFICIENT')
    expect(paymentsService.requestCapture).not.toHaveBeenCalled()
  })

  it('happy path → capture Stripe SYSTEM/AUTO_RELEASE + markCompleted + audits STARTED/TRIGGERED', async () => {
    const { executor, paymentsService, jobs, events } = buildHarness({})

    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })

    expect(result.outcome).toBe('COMPLETED')
    expect(paymentsService.requestCapture).toHaveBeenCalledTimes(1)
    expect(paymentsService.requestCapture).toHaveBeenCalledWith(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'AUTO_RELEASE',
    })
    expect(jobs.markCompletedTx).toHaveBeenCalledTimes(1)

    const auditTypes = [
      ...events.record.mock.calls.map((call) => (call[0] as { type: string }).type),
      ...events.recordTx.mock.calls.map((call) => (call[1] as { type: string }).type),
    ]
    expect(auditTypes).toContain('AUTO_RELEASE_STARTED')
    expect(auditTypes).toContain('AUTO_RELEASE_TRIGGERED')
  })

  it('PaymentNotCapturable depuis requestCapture → BLOCKED (pas FAILED → pas retry inutile)', async () => {
    const { executor, paymentsService, jobs } = buildHarness({})
    paymentsService.requestCapture.mockRejectedValueOnce(
      new PaymentNotCapturableException('payment_status_must_be_AUTHORIZED (current: FAILED)'),
    )
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).toBe('PAYMENT_NOT_AUTHORIZED')
    expect(jobs.markCompletedTx).not.toHaveBeenCalled()
  })

  it('PaymentAuthorizationExpired depuis requestCapture → BLOCKED PAYMENT_AUTHORIZATION_EXPIRED', async () => {
    const { executor, paymentsService } = buildHarness({})
    paymentsService.requestCapture.mockRejectedValueOnce(new PaymentAuthorizationExpiredException())
    const result = await executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID })
    expect(result.outcome).toBe('BLOCKED')
    expect(result.reason).toBe('PAYMENT_AUTHORIZATION_EXPIRED')
  })

  it('erreur Stripe réseau → FAILED + re-throw (retry BullMQ)', async () => {
    const { executor, paymentsService, jobs, events } = buildHarness({})
    paymentsService.requestCapture.mockRejectedValueOnce(new Error('Stripe network failure'))
    await expect(
      executor.run({ autoReleaseJobId: JOB_ID, missionId: MISSION_ID, workerId: WORKER_ID }),
    ).rejects.toThrow('Stripe network failure')
    expect(jobs.markFailedTx).toHaveBeenCalledTimes(1)

    const failedAudit = events.recordTx.mock.calls.find(
      (call) => (call[1] as { type: string }).type === 'AUTO_RELEASE_FAILED',
    )
    expect(failedAudit).toBeDefined()
  })
})
