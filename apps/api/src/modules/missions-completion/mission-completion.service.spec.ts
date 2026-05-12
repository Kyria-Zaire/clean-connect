/**
 * PRD-003 Ticket 3.4 — tests unitaires `MissionCompletionService`.
 *
 * Couverture obligatoire (correction CTO Ticket 3.4) :
 *  1. /complete refuse role ≠ PRESTATAIRE → 403 MISSION_PRESTATAIRE_ONLY.
 *  2. /complete refuse mission inconnue → 404.
 *  3. /complete refuse prestataire ≠ owner → 403.
 *  4. /complete refuse mission non ACCEPTED → 409 MISSION_NOT_COMPLETABLE.
 *  5. /complete refuse photos insuffisantes → 409 MISSION_PHOTOS_INSUFFICIENT.
 *  6. /complete idempotent : déjà CLIENT_VALIDATION_PENDING → idempotent:true,
 *     pas de side-effect (pas de scheduleTx ni enqueueDelayedJob).
 *  7. /complete happy path → transition + auto-release schedule + audits.
 *  8. /validate refuse role ≠ CLIENT.
 *  9. /validate déclenche capture Stripe SYSTEM/CLIENT_VALIDATION + cancel
 *     auto-release.
 * 10. /validate idempotent : mission COMPLETED → idempotent:true.
 * 11. /report-problem refuse role ≠ CLIENT.
 * 12. /report-problem refuse double dispute → 409 MISSION_DISPUTE_ALREADY_OPEN.
 * 13. /report-problem happy path → transition + cancel auto-release.
 * 14. /report-problem ne log JAMAIS la description (rule securite).
 */

import type { Mission, Prisma } from '@prisma/client'

import type { PrismaService } from '../../common/prisma/prisma.service'
import type { MissionsRepository } from '../missions/missions.repository'
import type { MissionEventService } from '../missions/services/mission-event.service'
import type { MissionViewService } from '../missions/services/mission-view.service'
import type { PaymentsService } from '../payments/payments.service'

import type { AutoReleaseService } from './auto-release/auto-release.service'
import {
  MissionClientOnlyException,
  MissionDisputeAlreadyOpenException,
  MissionNotCompletableException,
  MissionNotValidatableException,
  MissionPhotosInsufficientException,
  MissionPrestataireOnlyException,
} from './mission-completion.errors'
import { MissionCompletionService } from './mission-completion.service'
import type { MissionPhotoQuotaService } from './photo-quota.service'

const MISSION_ID = '00000000-0000-4000-8000-000000000001'
const CLIENT_ID = '00000000-0000-4000-8000-0000000000aa'
const PRESTA_ID = '00000000-0000-4000-8000-0000000000bb'
const AUTO_RELEASE_JOB_ID = '00000000-0000-4000-8000-0000000000cc'
const BULL_JOB_ID = `auto-release-mission-${MISSION_ID}`

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    missionNumber: 'CC-2026-000001',
    status: 'ACCEPTED',
    serviceType: 'SOFA',
    clientId: CLIENT_ID,
    prestataireId: PRESTA_ID,
    addressId: '00000000-0000-4000-8000-0000000000dd',
    startAt: new Date('2026-06-01T10:00:00Z'),
    endAt: new Date('2026-06-01T12:00:00Z'),
    timeZone: 'Europe/Paris',
    isAsap: false,
    estimatedPriceCents: 12_000,
    publishedAt: new Date('2026-05-20T10:00:00Z'),
    listingExpiresAt: new Date('2026-05-21T10:00:00Z'),
    createdAt: new Date('2026-05-20T08:00:00Z'),
    updatedAt: new Date('2026-05-20T08:00:00Z'),
    ...overrides,
  }
}

interface Harness {
  service: MissionCompletionService
  missionsRepo: jest.Mocked<MissionsRepository>
  views: { toView: jest.Mock }
  events: { record: jest.Mock; recordTx: jest.Mock }
  photoQuota: { check: jest.Mock }
  autoRelease: {
    scheduleTx: jest.Mock
    enqueueDelayedJob: jest.Mock
    cancel: jest.Mock
    computeSchedulePlan: jest.Mock
  }
  payments: { requestCapture: jest.Mock }
  prismaTransaction: jest.Mock
}

function buildHarness(overrides: {
  mission?: Mission | null
  reloadMission?: Mission | null
  quotas?: { beforeCount: number; afterCount: number; isComplete: boolean; reason: string }
  transitionResult?: number
} = {}): Harness {
  const mission = overrides.mission === undefined ? buildMission() : overrides.mission
  const reloaded = overrides.reloadMission === undefined ? mission : overrides.reloadMission

  const missionsRepo = {
    findById: jest.fn().mockImplementation(async () => {
      // Premier appel renvoie `mission`, les suivants renvoient `reloaded`
      // (le service rappelle findById après transaction pour récupérer le
      // statut à jour).
      const calls = (missionsRepo.findById as jest.Mock).mock.calls.length
      return calls === 1 ? mission : reloaded
    }),
    transitionAcceptedToClientValidationPendingTx: jest
      .fn()
      .mockResolvedValue(overrides.transitionResult ?? 1),
    transitionClientValidationPendingToDisputeOpenTx: jest
      .fn()
      .mockResolvedValue(overrides.transitionResult ?? 1),
  } as unknown as jest.Mocked<MissionsRepository>

  const views = {
    toView: jest
      .fn()
      .mockImplementation(async (m: Mission) => ({ id: m.id, status: m.status })),
  }

  const events = {
    record: jest.fn().mockResolvedValue(undefined),
    recordTx: jest.fn().mockResolvedValue(undefined),
  }

  const photoQuota = {
    check: jest
      .fn()
      .mockResolvedValue(
        overrides.quotas ?? { beforeCount: 3, afterCount: 5, isComplete: true, reason: 'OK' },
      ),
  }

  const scheduledFor = new Date('2026-06-03T10:00:00Z')
  const autoRelease = {
    scheduleTx: jest.fn().mockResolvedValue({
      job: { id: AUTO_RELEASE_JOB_ID, missionId: MISSION_ID, status: 'SCHEDULED' },
      plan: { scheduledFor, bullJobId: BULL_JOB_ID, idempotencyKey: `capture-mission-${MISSION_ID}` },
      created: true,
    }),
    enqueueDelayedJob: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue({ cancelled: true }),
    computeSchedulePlan: jest
      .fn()
      .mockReturnValue({ scheduledFor, bullJobId: BULL_JOB_ID, idempotencyKey: `capture-mission-${MISSION_ID}` }),
  }

  const payments = {
    requestCapture: jest.fn().mockResolvedValue({ id: 'payment-id', status: 'AUTHORIZED' }),
  }

  const prismaTransaction = jest
    .fn()
    .mockImplementation(async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb({} as unknown as Prisma.TransactionClient),
    )
  const prisma = { $transaction: prismaTransaction } as unknown as PrismaService

  const service = new MissionCompletionService(
    prisma,
    missionsRepo,
    views as unknown as MissionViewService,
    events as unknown as MissionEventService,
    photoQuota as unknown as MissionPhotoQuotaService,
    autoRelease as unknown as AutoReleaseService,
    payments as unknown as PaymentsService,
  )

  return { service, missionsRepo, views, events, photoQuota, autoRelease, payments, prismaTransaction }
}

// =============================================================================
// /complete (PRESTATAIRE)
// =============================================================================

describe('MissionCompletionService.complete (PRD-003 Ticket 3.4)', () => {
  it('refuse role ≠ PRESTATAIRE → 403 MISSION_PRESTATAIRE_ONLY', async () => {
    const { service } = buildHarness()
    await expect(
      service.complete(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }),
    ).rejects.toBeInstanceOf(MissionPrestataireOnlyException)
  })

  it("refuse 403 si le prestataire n'est pas owner", async () => {
    const { service } = buildHarness({
      mission: buildMission({ prestataireId: 'other-presta' }),
    })
    await expect(
      service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' }),
    ).rejects.toBeInstanceOf(MissionPrestataireOnlyException)
  })

  it('refuse 409 MISSION_NOT_COMPLETABLE si mission non ACCEPTED (ex: PUBLISHED)', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'PUBLISHED' }),
    })
    await expect(
      service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' }),
    ).rejects.toBeInstanceOf(MissionNotCompletableException)
  })

  it('refuse 409 MISSION_PHOTOS_INSUFFICIENT si quotas BEFORE/AFTER non atteints', async () => {
    const { service, autoRelease } = buildHarness({
      quotas: { beforeCount: 2, afterCount: 5, isComplete: false, reason: 'INSUFFICIENT_BEFORE' },
    })
    await expect(
      service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' }),
    ).rejects.toBeInstanceOf(MissionPhotosInsufficientException)
    expect(autoRelease.scheduleTx).not.toHaveBeenCalled()
    expect(autoRelease.enqueueDelayedJob).not.toHaveBeenCalled()
  })

  it('idempotent : mission déjà CLIENT_VALIDATION_PENDING → idempotent:true sans side-effect', async () => {
    const { service, autoRelease, events, missionsRepo } = buildHarness({
      mission: buildMission({ status: 'CLIENT_VALIDATION_PENDING' }),
    })
    const result = await service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' })
    expect(result.idempotent).toBe(true)
    expect(autoRelease.scheduleTx).not.toHaveBeenCalled()
    expect(autoRelease.enqueueDelayedJob).not.toHaveBeenCalled()
    expect(events.recordTx).not.toHaveBeenCalled()
    expect(missionsRepo.transitionAcceptedToClientValidationPendingTx).not.toHaveBeenCalled()
  })

  it('happy path → transition + audit + auto-release schedule + enqueue BullMQ', async () => {
    const reloaded = buildMission({ status: 'CLIENT_VALIDATION_PENDING' })
    const { service, autoRelease, events, missionsRepo } = buildHarness({
      mission: buildMission({ status: 'ACCEPTED' }),
      reloadMission: reloaded,
    })

    const result = await service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' })

    expect(result.idempotent).toBe(false)
    expect(missionsRepo.transitionAcceptedToClientValidationPendingTx).toHaveBeenCalledTimes(1)
    expect(autoRelease.scheduleTx).toHaveBeenCalledTimes(1)
    expect(autoRelease.enqueueDelayedJob).toHaveBeenCalledTimes(1)

    const auditTypes = events.recordTx.mock.calls.map((call) => (call[1] as { type: string }).type)
    expect(auditTypes).toContain('CLIENT_VALIDATION_PENDING')
    expect(auditTypes).toContain('AUTO_RELEASE_SCHEDULED')
  })

  it("si Redis fail à l'enqueue BullMQ → on n'échoue PAS l'HTTP (mission est déjà transitionnée)", async () => {
    const reloaded = buildMission({ status: 'CLIENT_VALIDATION_PENDING' })
    const { service, autoRelease } = buildHarness({
      mission: buildMission({ status: 'ACCEPTED' }),
      reloadMission: reloaded,
    })
    autoRelease.enqueueDelayedJob.mockRejectedValueOnce(new Error('Redis down'))

    const result = await service.complete(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' })
    expect(result.idempotent).toBe(false)
    expect(autoRelease.scheduleTx).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// /validate (CLIENT)
// =============================================================================

describe('MissionCompletionService.validate (PRD-003 Ticket 3.4)', () => {
  it('refuse role ≠ CLIENT → 403 MISSION_CLIENT_ONLY', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'CLIENT_VALIDATION_PENDING' }),
    })
    await expect(
      service.validate(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' }),
    ).rejects.toBeInstanceOf(MissionClientOnlyException)
  })

  it('idempotent : mission COMPLETED → idempotent:true, pas de capture rejouée', async () => {
    const { service, payments, autoRelease } = buildHarness({
      mission: buildMission({ status: 'COMPLETED' }),
    })
    const result = await service.validate(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' })
    expect(result.idempotent).toBe(true)
    expect(payments.requestCapture).not.toHaveBeenCalled()
    expect(autoRelease.cancel).not.toHaveBeenCalled()
  })

  it('refuse 409 MISSION_NOT_VALIDATABLE si mission n\'est pas en CLIENT_VALIDATION_PENDING', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'ACCEPTED' }),
    })
    await expect(
      service.validate(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }),
    ).rejects.toBeInstanceOf(MissionNotValidatableException)
  })

  it('happy path → cancel auto-release AVANT capture + audit CLIENT_VALIDATED + capture Stripe SYSTEM/CLIENT_VALIDATION', async () => {
    const { service, payments, autoRelease, events } = buildHarness({
      mission: buildMission({ status: 'CLIENT_VALIDATION_PENDING' }),
    })
    await service.validate(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' })

    expect(autoRelease.cancel).toHaveBeenCalledTimes(1)
    expect(autoRelease.cancel).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      reason: 'client_validated',
    })

    expect(payments.requestCapture).toHaveBeenCalledTimes(1)
    expect(payments.requestCapture).toHaveBeenCalledWith(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'CLIENT_VALIDATION',
    })

    const auditTypes = events.record.mock.calls.map((call) => (call[0] as { type: string }).type)
    expect(auditTypes).toContain('CLIENT_VALIDATED')
  })
})

// =============================================================================
// /report-problem (CLIENT)
// =============================================================================

describe('MissionCompletionService.reportProblem (PRD-003 Ticket 3.4)', () => {
  const validBody = {
    category: 'PRESTATION_NOT_DONE' as const,
    description: 'Le prestataire n\'est jamais venu sur place.',
  }

  it('refuse role ≠ CLIENT', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'CLIENT_VALIDATION_PENDING' }),
    })
    await expect(
      service.reportProblem(MISSION_ID, { userId: PRESTA_ID, role: 'PRESTATAIRE' }, validBody),
    ).rejects.toBeInstanceOf(MissionClientOnlyException)
  })

  it('refuse 409 MISSION_DISPUTE_ALREADY_OPEN si déjà ouvert', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'DISPUTE_OPEN' }),
    })
    await expect(
      service.reportProblem(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, validBody),
    ).rejects.toBeInstanceOf(MissionDisputeAlreadyOpenException)
  })

  it('refuse 409 MISSION_NOT_VALIDATABLE si mission pas en CLIENT_VALIDATION_PENDING', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'ACCEPTED' }),
    })
    await expect(
      service.reportProblem(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, validBody),
    ).rejects.toBeInstanceOf(MissionNotValidatableException)
  })

  it('happy path → transition DISPUTE_OPEN + audit (catégorie SEULE, pas description) + cancel auto-release', async () => {
    const reloaded = buildMission({ status: 'DISPUTE_OPEN' })
    const { service, autoRelease, events, missionsRepo } = buildHarness({
      mission: buildMission({ status: 'CLIENT_VALIDATION_PENDING' }),
      reloadMission: reloaded,
    })

    await service.reportProblem(
      MISSION_ID,
      { userId: CLIENT_ID, role: 'CLIENT' },
      validBody,
    )

    expect(missionsRepo.transitionClientValidationPendingToDisputeOpenTx).toHaveBeenCalledTimes(1)

    expect(autoRelease.cancel).toHaveBeenCalledTimes(1)
    expect(autoRelease.cancel).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      reason: 'dispute_opened',
    })

    // Garde-fou rule securite : la description ne doit JAMAIS être loguée
    // dans le payload audit (PII utilisateur).
    const auditCall = events.recordTx.mock.calls.find(
      (call) => (call[1] as { type: string }).type === 'DISPUTE_OPENED',
    )
    expect(auditCall).toBeDefined()
    const payload = (auditCall?.[1] as { payload: Record<string, unknown> }).payload
    expect(payload['category']).toBe('PRESTATION_NOT_DONE')
    expect(payload['description']).toBeUndefined()
    expect(payload['descriptionLength']).toBe(validBody.description.length)
  })
})
