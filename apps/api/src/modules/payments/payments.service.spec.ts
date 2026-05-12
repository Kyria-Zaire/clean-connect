/**
 * Tests unitaires — `PaymentsService` (PRD-003 Ticket 3.2).
 *
 * Couverture obligatoire (correction CTO 2026-05-12) :
 *  1. `Idempotency-Key` manquant → 400 PAYMENT_MISSING_IDEMPOTENCY_KEY.
 *  2. Mission inexistante → 404 MISSION_NOT_FOUND.
 *  3. Mission non-owner → 403 MISSION_FORBIDDEN.
 *  4. Mission n'est pas en `DRAFT` → 409 PAYMENT_INVALID_STATE.
 *  5. Mission sans `estimatedPriceCents` → 422 PAYMENT_AMOUNT_REQUIRED.
 *  6. Happy path → PaymentIntent Stripe + Payment DB + Mission `PENDING_PAYMENT`.
 *  7. Replay même `Idempotency-Key` + même mission → MÊME Payment, AUCUN
 *     second appel `stripe.paymentIntents.create`.
 *  8. Replay même `Idempotency-Key` + mission différente → 409
 *     PAYMENT_IDEMPOTENCY_CONFLICT.
 *  9. `FF_PAYMENTS_ENABLED=false` → 503 PAYMENTS_DISABLED.
 * 10. Capture method passé à Stripe est BIEN `'manual'` (correction CTO).
 */

import type { Mission, Payment, Prisma } from '@prisma/client'

import { __resetEnvCacheForTests } from '../../common/config/env'
import type { PrismaService } from '../../common/prisma/prisma.service'
import type { MissionsRepository } from '../missions/missions.repository'
import type { MissionEventService } from '../missions/services/mission-event.service'

import {
  MissionForbiddenException,
  MissionNotFoundException,
  PaymentAmountRequiredException,
  PaymentAuthorizationExpiredException,
  PaymentIdempotencyConflictException,
  PaymentInvalidStateException,
  PaymentMissingIdempotencyKeyException,
  PaymentNotCapturableException,
  PaymentStripeException,
  PaymentsDisabledException,
} from './payments.errors'
import type { PaymentsRepository } from './payments.repository'
import { PaymentsService } from './payments.service'

const VALID_KEY = 'cc-test-idempotency-key-1234'
const OTHER_KEY = 'cc-test-idempotency-key-9999'
const MISSION_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_MISSION_ID = '00000000-0000-4000-8000-000000000002'
const CLIENT_ID = '00000000-0000-4000-8000-0000000000aa'
const OTHER_CLIENT_ID = '00000000-0000-4000-8000-0000000000bb'

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    missionNumber: 'CC-2026-000001',
    status: 'DRAFT',
    serviceType: 'SOFA',
    clientId: CLIENT_ID,
    prestataireId: null,
    addressId: '00000000-0000-4000-8000-0000000000cc',
    startAt: new Date('2026-06-01T10:00:00Z'),
    endAt: new Date('2026-06-01T12:00:00Z'),
    timeZone: 'Europe/Paris',
    isAsap: false,
    estimatedPriceCents: 12_000,
    publishedAt: null,
    listingExpiresAt: null,
    createdAt: new Date('2026-05-12T10:00:00Z'),
    updatedAt: new Date('2026-05-12T10:00:00Z'),
    ...overrides,
  }
}

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '00000000-0000-4000-8000-0000000000dd',
    missionId: MISSION_ID,
    stripePaymentIntentId: 'pi_test_unit_001',
    idempotencyKey: VALID_KEY,
    amountAuthorizedCents: 12_000,
    amountCapturedCents: null,
    currency: 'eur',
    applicationFeeCents: 2_160,
    providerPayoutCents: 9_840,
    vatRateSnapshot: null,
    status: 'AUTHORIZATION_PENDING',
    failureCode: null,
    failureMessage: null,
    createdAt: new Date('2026-05-12T10:00:00Z'),
    updatedAt: new Date('2026-05-12T10:00:00Z'),
    ...overrides,
  }
}

interface ServiceHarness {
  service: PaymentsService
  stripeCreate: jest.Mock
  stripeRetrieve: jest.Mock
  stripeCapture: jest.Mock
  paymentsRepo: jest.Mocked<PaymentsRepository>
  missionsRepo: jest.Mocked<MissionsRepository>
  missionEvents: { recordTx: jest.Mock }
  prismaTransaction: jest.Mock
}

function buildHarness(opts: {
  mission?: Mission | null
  existingPayment?: Payment | null
  paymentsEnabled?: boolean
  transitionResult?: number
  stripeCreateResult?: Partial<{
    id: string
    client_secret: string
  }>
} = {}): ServiceHarness {
  process.env['NODE_ENV'] = 'development'
  process.env['APP_ENV'] = 'development'
  process.env['DATABASE_URL'] = 'postgresql://unit:unit@localhost:5499/unit'
  process.env['REDIS_URL'] = 'redis://localhost:6399'
  process.env['CORS_ORIGINS'] = 'http://localhost:5173'
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48)
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48)
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_unit'
  process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_unit_test_secret_min_32chars_aaa'
  process.env['STRIPE_API_VERSION'] = '2025-02-24.acacia'
  process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] = '300'
  process.env['FF_PAYMENTS_ENABLED'] = opts.paymentsEnabled === false ? 'false' : 'true'
  process.env['APP_VERSION'] = '0.0.0-test'
  process.env['PAYMENT_PLATFORM_FEE_RATE'] = '0.18'
  __resetEnvCacheForTests()

  const missionFromOpts = opts.mission === undefined ? buildMission() : opts.mission
  const missionsRepo = {
    findById: jest.fn().mockResolvedValue(missionFromOpts),
    transitionDraftToPendingPaymentTx: jest
      .fn()
      .mockResolvedValue(opts.transitionResult ?? 1),
  } as unknown as jest.Mocked<MissionsRepository>

  const paymentsRepo = {
    findByIdempotencyKey: jest.fn().mockResolvedValue(opts.existingPayment ?? null),
    findByMissionId: jest.fn().mockResolvedValue(opts.existingPayment ?? null),
    createPendingPaymentTx: jest.fn().mockImplementation(async (_tx, input) =>
      buildPayment({
        missionId: input.missionId,
        stripePaymentIntentId: input.stripePaymentIntentId,
        idempotencyKey: input.idempotencyKey,
        amountAuthorizedCents: input.amountAuthorizedCents,
        applicationFeeCents: input.applicationFeeCents,
        providerPayoutCents: input.providerPayoutCents,
      }),
    ),
  } as unknown as jest.Mocked<PaymentsRepository>

  const stripeCreate = jest.fn().mockResolvedValue({
    id: opts.stripeCreateResult?.id ?? 'pi_test_unit_001',
    client_secret: opts.stripeCreateResult?.client_secret ?? 'pi_test_unit_001_secret_aaa',
    object: 'payment_intent',
  })
  const stripeRetrieve = jest.fn().mockResolvedValue({
    id: opts.existingPayment?.stripePaymentIntentId ?? 'pi_test_unit_001',
    client_secret: 'pi_test_unit_001_secret_bbb',
    object: 'payment_intent',
  })
  const stripeCapture = jest.fn().mockResolvedValue({
    id: opts.existingPayment?.stripePaymentIntentId ?? 'pi_test_unit_001',
    object: 'payment_intent',
    status: 'succeeded',
  })

  const stripe = {
    paymentIntents: { create: stripeCreate, retrieve: stripeRetrieve, capture: stripeCapture },
  }

  const prismaTransaction = jest
    .fn()
    .mockImplementation(async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb({} as unknown as Prisma.TransactionClient),
    )
  const prisma = { $transaction: prismaTransaction } as unknown as PrismaService

  const missionEvents = {
    recordTx: jest.fn().mockResolvedValue(undefined),
  }

  // PRD-004 A3-bis : injection d'un tracker neutre (no-op métriques) — on
  // exerce le code path complet sans dépendre du registry Prometheus réel.
  const stripeMetrics = {
    time: jest.fn().mockImplementation(<T>(_op: string, fn: () => Promise<T>) => fn()),
    timeSync: jest.fn().mockImplementation(<T>(_op: string, fn: () => T) => fn()),
  }

  const service = new PaymentsService(
    prisma,
    paymentsRepo,
    missionsRepo,
    missionEvents as unknown as MissionEventService,
    stripeMetrics as never,
    stripe as never,
  )

  return {
    service,
    stripeCreate,
    stripeRetrieve,
    stripeCapture,
    paymentsRepo,
    missionsRepo,
    missionEvents,
    prismaTransaction,
  }
}

describe('PaymentsService.createIntent (PRD-003 Ticket 3.2)', () => {
  it('refuse l\'absence de header Idempotency-Key (400 PAYMENT_MISSING_IDEMPOTENCY_KEY)', async () => {
    const { service } = buildHarness({})
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, undefined),
    ).rejects.toBeInstanceOf(PaymentMissingIdempotencyKeyException)
  })

  it('refuse une Idempotency-Key avec un charset invalide', async () => {
    const { service } = buildHarness({})
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, 'short!@#'),
    ).rejects.toBeInstanceOf(PaymentMissingIdempotencyKeyException)
  })

  it('lève 404 si la mission est introuvable', async () => {
    const { service } = buildHarness({ mission: null })
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, VALID_KEY),
    ).rejects.toBeInstanceOf(MissionNotFoundException)
  })

  it('lève 403 si le client n\'est pas propriétaire de la mission', async () => {
    const { service } = buildHarness({
      mission: buildMission({ clientId: OTHER_CLIENT_ID }),
    })
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, VALID_KEY),
    ).rejects.toBeInstanceOf(MissionForbiddenException)
  })

  it('lève 409 PAYMENT_INVALID_STATE si la mission n\'est pas en DRAFT', async () => {
    const { service } = buildHarness({
      mission: buildMission({ status: 'PUBLISHED' }),
    })
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, VALID_KEY),
    ).rejects.toBeInstanceOf(PaymentInvalidStateException)
  })

  it('lève 422 PAYMENT_AMOUNT_REQUIRED si la mission n\'a pas de montant', async () => {
    const { service } = buildHarness({
      mission: buildMission({ estimatedPriceCents: null }),
    })
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, VALID_KEY),
    ).rejects.toBeInstanceOf(PaymentAmountRequiredException)
  })

  it('lève 503 PAYMENTS_DISABLED quand le feature flag est off', async () => {
    const { service } = buildHarness({ paymentsEnabled: false })
    await expect(
      service.createIntent(MISSION_ID, { userId: CLIENT_ID, role: 'CLIENT' }, VALID_KEY),
    ).rejects.toBeInstanceOf(PaymentsDisabledException)
  })

  it('happy path → PaymentIntent (capture_method=manual) + Payment DB + transition DRAFT→PENDING_PAYMENT', async () => {
    const harness = buildHarness({})
    const response = await harness.service.createIntent(
      MISSION_ID,
      { userId: CLIENT_ID, role: 'CLIENT' },
      VALID_KEY,
    )

    // 1. Stripe appelé avec idempotency-key client + capture_method=manual
    expect(harness.stripeCreate).toHaveBeenCalledTimes(1)
    const [stripeArgs, stripeOpts] = harness.stripeCreate.mock.calls[0] as [
      { capture_method?: string; amount?: number; currency?: string; metadata?: Record<string, string> },
      { idempotencyKey?: string },
    ]
    expect(stripeArgs.capture_method).toBe('manual')
    expect(stripeArgs.amount).toBe(12_000)
    expect(stripeArgs.currency).toBe('eur')
    expect(stripeArgs.metadata?.['missionId']).toBe(MISSION_ID)
    expect(stripeOpts.idempotencyKey).toBe(VALID_KEY)

    // 2. Payment créé en AUTHORIZATION_PENDING avec idempotencyKey persistée
    expect(harness.paymentsRepo.createPendingPaymentTx).toHaveBeenCalledTimes(1)
    const insertedInput = harness.paymentsRepo.createPendingPaymentTx.mock.calls[0]?.[1] as {
      amountAuthorizedCents: number
      applicationFeeCents: number
      providerPayoutCents: number
      idempotencyKey: string
    }
    expect(insertedInput.amountAuthorizedCents).toBe(12_000)
    expect(insertedInput.applicationFeeCents).toBe(2_160)
    expect(insertedInput.providerPayoutCents).toBe(9_840)
    expect(insertedInput.idempotencyKey).toBe(VALID_KEY)

    // 3. Mission DRAFT → PENDING_PAYMENT (lock optimiste)
    expect(harness.missionsRepo.transitionDraftToPendingPaymentTx).toHaveBeenCalledTimes(1)

    // 4. Réponse client : clientSecret retourné UNIQUEMENT ici
    expect(response.clientSecret).toBe('pi_test_unit_001_secret_aaa')
    expect(response.status).toBe('AUTHORIZATION_PENDING')
    expect(response.amountAuthorizedCents).toBe(12_000)
    expect(response.currency).toBe('eur')
  })

  it('replay même Idempotency-Key + même missionId → MÊME Payment, AUCUN second appel Stripe create', async () => {
    const existing = buildPayment()
    const harness = buildHarness({ existingPayment: existing })
    const response = await harness.service.createIntent(
      MISSION_ID,
      { userId: CLIENT_ID, role: 'CLIENT' },
      VALID_KEY,
    )

    expect(harness.stripeCreate).not.toHaveBeenCalled()
    expect(harness.stripeRetrieve).toHaveBeenCalledTimes(1)
    expect(response.paymentId).toBe(existing.id)
    expect(response.stripePaymentIntentId).toBe(existing.stripePaymentIntentId)
    expect(response.status).toBe(existing.status)
    // Le clientSecret retourné vient du retrieve Stripe (pas DB)
    expect(response.clientSecret).toBe('pi_test_unit_001_secret_bbb')
  })

  it('replay même Idempotency-Key + missionId DIFFÉRENTE → 409 PAYMENT_IDEMPOTENCY_CONFLICT', async () => {
    const existing = buildPayment({ missionId: OTHER_MISSION_ID })
    const harness = buildHarness({
      mission: buildMission({ id: MISSION_ID }),
      existingPayment: existing,
    })
    await expect(
      harness.service.createIntent(
        MISSION_ID,
        { userId: CLIENT_ID, role: 'CLIENT' },
        VALID_KEY,
      ),
    ).rejects.toBeInstanceOf(PaymentIdempotencyConflictException)
    expect(harness.stripeCreate).not.toHaveBeenCalled()
  })

  it('une mission concurremment cancelée pendant la création → erreur PAYMENT_INVALID_STATE (transitionDraftToPendingPaymentTx renvoie 0)', async () => {
    const harness = buildHarness({ transitionResult: 0 })
    await expect(
      harness.service.createIntent(
        MISSION_ID,
        { userId: CLIENT_ID, role: 'CLIENT' },
        OTHER_KEY,
      ),
    ).rejects.toBeInstanceOf(PaymentInvalidStateException)
  })
})

// =============================================================================
// PRD-003 Ticket 3.4 — PaymentsService.requestCapture
// =============================================================================

describe('PaymentsService.requestCapture (PRD-003 Ticket 3.4)', () => {
  it('lève 409 PAYMENT_NOT_CAPTURABLE si aucun payment lié à la mission', async () => {
    const harness = buildHarness({ existingPayment: null })
    await expect(
      harness.service.requestCapture(MISSION_ID, {
        kind: 'SYSTEM',
        trigger: 'CLIENT_VALIDATION',
      }),
    ).rejects.toBeInstanceOf(PaymentNotCapturableException)
    expect(harness.stripeCapture).not.toHaveBeenCalled()
  })

  it('lève 422 PAYMENT_AUTHORIZATION_EXPIRED si payment CANCELLED avec failureCode=authorization_expired', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({
        status: 'CANCELLED',
        failureCode: 'authorization_expired',
      }),
    })
    await expect(
      harness.service.requestCapture(MISSION_ID, {
        kind: 'SYSTEM',
        trigger: 'AUTO_RELEASE',
      }),
    ).rejects.toBeInstanceOf(PaymentAuthorizationExpiredException)
    expect(harness.stripeCapture).not.toHaveBeenCalled()
  })

  it('idempotent : si payment déjà CAPTURED → no-op (pas de capture Stripe rejouée)', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({ status: 'CAPTURED' }),
    })
    const result = await harness.service.requestCapture(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'CLIENT_VALIDATION',
    })
    expect(result.status).toBe('CAPTURED')
    expect(harness.stripeCapture).not.toHaveBeenCalled()
  })

  it('lève 409 PAYMENT_NOT_CAPTURABLE si payment AUTHORIZATION_PENDING / FAILED / REFUNDED', async () => {
    for (const status of ['AUTHORIZATION_PENDING', 'FAILED', 'REFUNDED'] as const) {
      const harness = buildHarness({
        existingPayment: buildPayment({ status }),
      })
      await expect(
        harness.service.requestCapture(MISSION_ID, {
          kind: 'SYSTEM',
          trigger: 'AUTO_RELEASE',
        }),
      ).rejects.toBeInstanceOf(PaymentNotCapturableException)
      expect(harness.stripeCapture).not.toHaveBeenCalled()
    }
  })

  it('happy path SYSTEM/CLIENT_VALIDATION → capture Stripe avec idempotencyKey déterministe + audit PAYMENT_CAPTURE_REQUESTED', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({ status: 'AUTHORIZED' }),
    })
    await harness.service.requestCapture(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'CLIENT_VALIDATION',
    })

    expect(harness.stripeCapture).toHaveBeenCalledTimes(1)
    const [intentId, body, opts] = harness.stripeCapture.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { idempotencyKey: string },
    ]
    expect(intentId).toBe('pi_test_unit_001')
    expect(body).toEqual({})
    expect(opts.idempotencyKey).toBe(`capture-mission-${MISSION_ID}`)

    expect(harness.missionEvents.recordTx).toHaveBeenCalledTimes(1)
    const auditPayload = harness.missionEvents.recordTx.mock.calls[0]?.[1] as {
      type: string
      actorUserId: string | null
      payload: Record<string, unknown>
    }
    expect(auditPayload.type).toBe('PAYMENT_CAPTURE_REQUESTED')
    expect(auditPayload.actorUserId).toBeNull() // SYSTEM
    expect(auditPayload.payload['trigger']).toBe('CLIENT_VALIDATION')
    expect(auditPayload.payload['idempotencyKey']).toBe(`capture-mission-${MISSION_ID}`)
  })

  it('happy path ADMIN → capture avec actorUserId=admin (audit override)', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({ status: 'AUTHORIZED' }),
    })
    const adminId = '00000000-0000-4000-8000-00000000a0a0'
    await harness.service.requestCapture(MISSION_ID, { kind: 'ADMIN', userId: adminId })

    const auditPayload = harness.missionEvents.recordTx.mock.calls[0]?.[1] as {
      actorUserId: string | null
      payload: Record<string, unknown>
    }
    expect(auditPayload.actorUserId).toBe(adminId)
    expect(auditPayload.payload['trigger']).toBe('ADMIN_OVERRIDE')
  })

  it('même Idempotency-Key pour validate et auto-release (race) → garantie côté Stripe', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({ status: 'AUTHORIZED' }),
    })

    await harness.service.requestCapture(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'CLIENT_VALIDATION',
    })
    await harness.service.requestCapture(MISSION_ID, {
      kind: 'SYSTEM',
      trigger: 'AUTO_RELEASE',
    })

    expect(harness.stripeCapture).toHaveBeenCalledTimes(2)
    const opts1 = harness.stripeCapture.mock.calls[0]?.[2] as { idempotencyKey: string }
    const opts2 = harness.stripeCapture.mock.calls[1]?.[2] as { idempotencyKey: string }
    expect(opts1.idempotencyKey).toBe(opts2.idempotencyKey)
    expect(opts1.idempotencyKey).toBe(`capture-mission-${MISSION_ID}`)
  })

  it('erreur réseau Stripe → PaymentStripeException remontée', async () => {
    const harness = buildHarness({
      existingPayment: buildPayment({ status: 'AUTHORIZED' }),
    })
    harness.stripeCapture.mockRejectedValueOnce(new Error('Stripe network error'))
    await expect(
      harness.service.requestCapture(MISSION_ID, {
        kind: 'SYSTEM',
        trigger: 'AUTO_RELEASE',
      }),
    ).rejects.toBeInstanceOf(PaymentStripeException)
  })

  it('refuse 503 PAYMENTS_DISABLED quand FF off', async () => {
    const harness = buildHarness({ paymentsEnabled: false })
    await expect(
      harness.service.requestCapture(MISSION_ID, {
        kind: 'SYSTEM',
        trigger: 'CLIENT_VALIDATION',
      }),
    ).rejects.toBeInstanceOf(PaymentsDisabledException)
  })
})
