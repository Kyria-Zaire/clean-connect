/**
 * PRD-003 Ticket 3.2 — `PaymentsService`.
 *
 * Orchestre la création d'un `PaymentIntent` Stripe pour une mission CLIENT :
 *
 *   1. Vérifie l'ownership mission + l'état (`DRAFT` uniquement).
 *   2. Snapshot des montants (lock-in commission ADR-008).
 *   3. Idempotence DB **avant** Stripe (header `Idempotency-Key` → unique
 *      index `payments_idempotency_key_key`).
 *   4. Crée le `PaymentIntent` côté Stripe (`capture_method='manual'` —
 *      CORRECTION CTO Ticket 3.2 : pas de capture automatique).
 *   5. Persiste `Payment` (`AUTHORIZATION_PENDING`) + transition Mission
 *      `DRAFT → PENDING_PAYMENT` dans la même `$transaction`.
 *   6. Renvoie `{ clientSecret, paymentIntentId, status, … }` au CLIENT
 *      (clientSecret JAMAIS refetchable ensuite — règle CTO 3.2).
 *
 * Hors-scope 3.2 : transfer prestataire, refund, capture, photos, auto-release.
 *
 * Garde-fous (rule securite + stripe) :
 *  - `idempotencyKey` client passé tel quel à Stripe (anti double-charge réseau).
 *  - Aucun `clientSecret` ni `failureMessage` brut Stripe loggé (Pino redactor).
 *  - Tous les montants en centimes (`number` int), validés Zod (`moneyCentsPositiveSchema`).
 */

import type {
  AdminPaymentListQuery,
  AdminPaymentListResponse,
  AdminPaymentView,
  ClientPaymentListQuery,
  ClientPaymentListResponse,
  ClientPaymentView,
  CreatePaymentIntentResponse,
} from '@cc/shared-types'
import { idempotencyKeySchema } from '@cc/shared-types'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Mission, Payment, Prisma } from '@prisma/client'
import type Stripe from 'stripe'

import { loadEnv } from '../../common/config/env'
import { PrismaService } from '../../common/prisma/prisma.service'
import { MissionsRepository } from '../missions/missions.repository'
import { MissionEventService } from '../missions/services/mission-event.service'
import { buildCaptureIdempotencyKey } from '../missions-completion/auto-release/auto-release.constants'
import { StripeMetricsTracker } from '../observability/metrics/stripe-metrics.tracker'

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
import { PaymentsRepository } from './payments.repository'
import { STRIPE_CLIENT_TOKEN } from './stripe/stripe.client'

/** Acteur HTTP authentifié (uniquement CLIENT pour `createIntent`). */
interface ClientActor {
  userId: string
  role: 'CLIENT'
}

/**
 * PRD-003 Ticket 3.4 — acteur autorisé à déclencher une capture PaymentIntent.
 *
 * - `SYSTEM` : déclenché par `MissionCompletionService.validate()` (qui agit
 *   pour le CLIENT après validation manuelle) **ou** par l'`AutoReleaseExecutor`
 *   (T+48h ouvrées BullMQ). Aucun `userId` car aucun humain n'a directement
 *   appelé l'endpoint Stripe.
 * - `ADMIN` : capture exceptionnelle déclenchée depuis le back-office (cas
 *   support — débloquer une mission litigieuse résolue manuellement). Audit
 *   identifie l'admin via `userId`.
 *
 * **JAMAIS de capture par un acteur CLIENT direct** (rule securite + CTO 3.2
 * ajustement #4). Le client valide → service capture en tant que SYSTEM.
 */
export type CaptureActor =
  | { kind: 'SYSTEM'; trigger: 'CLIENT_VALIDATION' | 'AUTO_RELEASE' }
  | { kind: 'ADMIN'; userId: string }

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name)
  private readonly platformFeeRate: number
  private readonly paymentsEnabled: boolean

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsRepository,
    private readonly missions: MissionsRepository,
    private readonly missionEvents: MissionEventService,
    private readonly stripeMetrics: StripeMetricsTracker,
    @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe: Stripe,
  ) {
    // `loadEnv()` retourne un objet déjà validé / transformé (booleans et
    // numbers parsés). On NE passe pas par `ConfigService.get()` car celui-ci
    // renverrait les valeurs `process.env` brutes (strings) et casserait le
    // check `!this.paymentsEnabled` (la string `"false"` est truthy).
    const env = loadEnv()
    this.platformFeeRate = env.PAYMENT_PLATFORM_FEE_RATE
    this.paymentsEnabled = env.FF_PAYMENTS_ENABLED
  }

  // ---------------------------------------------------------------------------
  // CLIENT — POST /v1/payments/intent
  // ---------------------------------------------------------------------------

  /**
   * Crée (ou retourne via idempotence) un PaymentIntent Stripe pour la mission.
   *
   * Idempotence stricte (rule stripe + CTO 3.2) :
   *  - Même `Idempotency-Key` + même `missionId` → MÊME Payment, MÊME
   *    `clientSecret` (cas attendu : retry réseau client).
   *  - Même `Idempotency-Key` + `missionId` différente → 409
   *    `PAYMENT_IDEMPOTENCY_CONFLICT` (anti-piège).
   *  - Pas de header `Idempotency-Key` → 400 `PAYMENT_MISSING_IDEMPOTENCY_KEY`.
   */
  async createIntent(
    missionId: string,
    actor: ClientActor,
    idempotencyKeyHeader: string | undefined,
  ): Promise<CreatePaymentIntentResponse> {
    if (!this.paymentsEnabled) throw new PaymentsDisabledException()

    const idempotencyKey = this.parseIdempotencyKey(idempotencyKeyHeader)

    const mission = await this.missions.findById(missionId)
    if (!mission) throw new MissionNotFoundException()
    if (mission.clientId !== actor.userId) throw new MissionForbiddenException()

    // 1. Idempotence DB AVANT toute interaction Stripe (replay réseau client).
    const existing = await this.payments.findByIdempotencyKey(idempotencyKey)
    if (existing) {
      if (existing.missionId !== mission.id) {
        throw new PaymentIdempotencyConflictException(
          'idempotency_key_already_used_for_another_mission',
        )
      }
      // Replay légitime — on RE-FETCH le PaymentIntent Stripe pour récupérer
      // le clientSecret (jamais persisté côté DB pour sécurité).
      return this.replayExisting(existing)
    }

    // 2. État mission : doit être DRAFT (sinon PAYMENT_INVALID_STATE).
    // Note : DRAFT → PENDING_PAYMENT autorisé par la state machine (cf.
    // `mission-state.machine.ts`). Si la mission a déjà un Payment lié
    // (race idempotency-key), `Payment.missionId` unique va bloquer.
    if (mission.status !== 'DRAFT') {
      throw new PaymentInvalidStateException(
        `mission_status_must_be_DRAFT (current: ${mission.status})`,
      )
    }
    if (mission.estimatedPriceCents === null || mission.estimatedPriceCents <= 0) {
      throw new PaymentAmountRequiredException()
    }

    // 3. Snapshot lock-in commission (ADR-008 §4).
    const amountAuthorizedCents = mission.estimatedPriceCents
    const applicationFeeCents = Math.round(amountAuthorizedCents * this.platformFeeRate)
    const providerPayoutCents = amountAuthorizedCents - applicationFeeCents
    const currency = 'eur' as const

    // 4. Création PaymentIntent Stripe avec idempotency-key client telle quelle.
    let intent: Stripe.PaymentIntent
    try {
      intent = await this.stripeMetrics.time('payment_intents.create', () =>
        this.stripe.paymentIntents.create(
          {
            amount: amountAuthorizedCents,
            currency,
            // CORRECTION CTO 3.2 : capture_method='manual' OBLIGATOIRE — pas de
            // capture automatique au paiement initial. La capture sera déclenchée
            // après validation client / auto-release / action admin (3.4).
            capture_method: 'manual',
            // Anti-fraude : on ne fait pas confiance au client pour spécifier le
            // moyen de paiement, Stripe.js / Payment Element gère ça côté mobile.
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            metadata: {
              missionId: mission.id,
              missionNumber: mission.missionNumber,
              clientId: mission.clientId,
              commissionSnapshotCents: applicationFeeCents.toString(),
              providerPayoutSnapshotCents: providerPayoutCents.toString(),
            },
          },
          { idempotencyKey },
        ),
      )
    } catch (err) {
      this.logger.error(
        {
          missionId: mission.id,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'payments.intent.stripe_create_failed',
      )
      throw new PaymentStripeException('stripe_create_failed')
    }

    // 5. Persiste Payment + transition Mission DRAFT → PENDING_PAYMENT atomiquement.
    let payment: Payment
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const inserted = await this.payments.createPendingPaymentTx(tx, {
          missionId: mission.id,
          stripePaymentIntentId: intent.id,
          idempotencyKey,
          amountAuthorizedCents,
          applicationFeeCents,
          providerPayoutCents,
          currency,
        })
        const transitioned = await this.missions.transitionDraftToPendingPaymentTx(
          tx,
          mission.id,
        )
        if (transitioned !== 1) {
          // Race rarissime : la mission a basculé entre le findById ci-dessus
          // et le moment du UPDATE. On laisse la transaction rollback ; le
          // Payment ne sera pas inséré, et Stripe gardera son PaymentIntent
          // (il sera nettoyé par BullMQ retry / DLQ admin Ticket 3.5).
          throw new PaymentInvalidStateException('mission_state_changed_concurrently')
        }
        await this.missionEvents.recordTx(tx, {
          missionId: mission.id,
          type: 'PAYMENT_INTENT_CREATED',
          actorUserId: actor.userId,
          payload: {
            paymentId: inserted.id,
            stripePaymentIntentId: intent.id,
            amountAuthorizedCents,
            applicationFeeCents,
            providerPayoutCents,
            currency,
          },
        })
        return inserted
      })
    } catch (err) {
      // Pour les erreurs métier (PaymentInvalidStateException), on relaie.
      // Pour les erreurs DB (P2002 idempotency_key race), on convertit.
      if (err instanceof PaymentInvalidStateException) throw err
      this.logger.error(
        {
          missionId: mission.id,
          intentId: intent.id,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'payments.intent.persist_failed',
      )
      throw new PaymentStripeException('persist_failed')
    }

    this.logger.log(
      {
        missionId: mission.id,
        paymentId: payment.id,
        intentId: intent.id,
        amountAuthorizedCents,
      },
      'payments.intent.created',
    )

    return {
      paymentId: payment.id,
      stripePaymentIntentId: intent.id,
      clientSecret: this.requireClientSecret(intent),
      amountAuthorizedCents,
      currency,
      status: payment.status,
    }
  }

  // ---------------------------------------------------------------------------
  // PRD-003 Ticket 3.4 — Capture (SYSTEM / ADMIN)
  // ---------------------------------------------------------------------------

  /**
   * Déclenche une capture Stripe sur un PaymentIntent encore en `AUTHORIZED`.
   *
   * Garanties :
   *  - Idempotence forte : la clé Stripe `capture-mission-<id>` est passée à
   *    chaque appel — un second `requestCapture()` concurrent (race
   *    `validate` vs `auto-release`) ne crée pas de double capture.
   *  - Aucune mutation DB côté `Payment` ici : la transition
   *    `AUTHORIZED → CAPTURED` se fait **uniquement** au webhook
   *    `payment_intent.succeeded` (`PaymentDomainHandler.onCaptured`).
   *    Cette séparation garantit que `Payment.amountCapturedCents` reflète
   *    toujours `amount_received` côté Stripe (source de vérité).
   *  - Audit `PAYMENT_CAPTURE_REQUESTED` (avant Stripe) + payment retourné
   *    tel quel.
   *
   * Le caller (`MissionCompletionService.validate` ou `AutoReleaseExecutor`)
   * **NE doit PAS** attendre que le payment passe à `CAPTURED` dans la même
   * requête HTTP : on renvoie la mission en `CLIENT_VALIDATION_PENDING` et
   * le webhook fera la transition vers `COMPLETED`.
   *
   * @throws PaymentNotCapturableException 409 — payment absent ou statut ≠
   *   AUTHORIZED (déjà capturé / failed / cancelled / refunded).
   * @throws PaymentAuthorizationExpiredException 422 — payment CANCELLED
   *   avec `failureCode='authorization_expired'` (7 j sans capture).
   * @throws PaymentStripeException 422 — appel Stripe failed (réseau /
   *   permission / configuration).
   */
  async requestCapture(missionId: string, actor: CaptureActor): Promise<Payment> {
    if (!this.paymentsEnabled) throw new PaymentsDisabledException()

    const payment = await this.payments.findByMissionId(missionId)
    if (!payment) {
      throw new PaymentNotCapturableException(`no_payment_for_mission`)
    }

    // Cas pathologique : autorisation expirée — Stripe a déjà annulé
    // l'intent il y a 7j+, on remonte un 422 distinct pour l'UX.
    if (payment.status === 'CANCELLED' && payment.failureCode === 'authorization_expired') {
      throw new PaymentAuthorizationExpiredException()
    }

    // Idempotence métier : si déjà CAPTURED → no-op silencieux (le caller
    // appellera la transition mission via webhook qui a déjà eu lieu).
    if (payment.status === 'CAPTURED') {
      return payment
    }
    if (payment.status !== 'AUTHORIZED') {
      throw new PaymentNotCapturableException(
        `payment_status_must_be_AUTHORIZED (current: ${payment.status})`,
      )
    }

    const idempotencyKey = buildCaptureIdempotencyKey(missionId)

    // Audit AVANT l'appel Stripe (audit Verify V4 — trace même en cas
    // d'échec réseau pour permettre l'investigation support).
    await this.prisma.$transaction(async (tx) => {
      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'PAYMENT_CAPTURE_REQUESTED',
        actorUserId: actor.kind === 'ADMIN' ? actor.userId : null,
        payload: {
          paymentId: payment.id,
          stripePaymentIntentId: payment.stripePaymentIntentId,
          trigger: actor.kind === 'SYSTEM' ? actor.trigger : 'ADMIN_OVERRIDE',
          idempotencyKey,
        },
      })
    })

    try {
      await this.stripeMetrics.time('payment_intents.capture', () =>
        this.stripe.paymentIntents.capture(
          payment.stripePaymentIntentId,
          // `amount_to_capture` non spécifié → capture full (`amount_authorized`).
          {},
          { idempotencyKey },
        ),
      )
    } catch (err) {
      this.logger.error(
        {
          missionId,
          paymentId: payment.id,
          intentId: payment.stripePaymentIntentId,
          actorKind: actor.kind,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'payments.capture.stripe_failed',
      )
      throw new PaymentStripeException('stripe_capture_failed')
    }

    this.logger.log(
      {
        missionId,
        paymentId: payment.id,
        intentId: payment.stripePaymentIntentId,
        actorKind: actor.kind,
      },
      'payments.capture.requested',
    )

    return payment
  }

  // ---------------------------------------------------------------------------
  // CLIENT — GET /v1/payments/mine
  // ---------------------------------------------------------------------------

  async listForClient(
    actor: ClientActor,
    query: ClientPaymentListQuery,
  ): Promise<ClientPaymentListResponse> {
    if (!this.paymentsEnabled) throw new PaymentsDisabledException()
    const rows = await this.payments.listForClient({
      clientId: actor.userId,
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    })
    return {
      items: rows.map((p) => this.toClientView(p)),
      nextCursor: rows.length === query.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    }
  }

  // ---------------------------------------------------------------------------
  // ADMIN — GET /v1/admin/payments
  // ---------------------------------------------------------------------------

  async listForAdmin(query: AdminPaymentListQuery): Promise<AdminPaymentListResponse> {
    if (!this.paymentsEnabled) throw new PaymentsDisabledException()
    const rows = await this.payments.listForAdmin({
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.clientId !== undefined ? { clientId: query.clientId } : {}),
      ...(query.missionId !== undefined ? { missionId: query.missionId } : {}),
    })
    return {
      items: rows.map((p) => this.toAdminView(p)),
      nextCursor: rows.length === query.limit ? (rows[rows.length - 1]?.id ?? null) : null,
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers privés
  // ---------------------------------------------------------------------------

  private parseIdempotencyKey(raw: string | undefined): string {
    if (!raw || raw.length === 0) throw new PaymentMissingIdempotencyKeyException()
    const parsed = idempotencyKeySchema.safeParse(raw)
    if (!parsed.success) {
      throw new PaymentMissingIdempotencyKeyException(
        parsed.error.issues[0]?.message ?? 'invalid_idempotency_key',
      )
    }
    return parsed.data
  }

  /**
   * Replay idempotent : on récupère le `clientSecret` actuel depuis Stripe.
   * Le clientSecret PEUT être différent si Stripe l'a recyclé (ex: 3DS step) —
   * mais l'idempotency-key garantit qu'aucun NOUVEAU PaymentIntent n'est créé.
   *
   * Note CTO 3.2 « clientSecret jamais refetchable » : interprétation stricte
   * = aucun endpoint dédié permettant de récupérer un clientSecret existant
   * (pas de `GET /payments/:id/secret`). En revanche, un replay de
   * `POST /v1/payments/intent` AVEC LA MÊME `Idempotency-Key` reste idempotent
   * et peut renvoyer le secret (cas retry réseau). On documente cette nuance
   * via TODO(debt) — sera tranché en Verify V11.
   *
   * `TODO(debt): client-secret-replay-strict-or-loose` — décision finale Verify.
   */
  private async replayExisting(existing: Payment): Promise<CreatePaymentIntentResponse> {
    let intent: Stripe.PaymentIntent
    try {
      intent = await this.stripeMetrics.time('payment_intents.retrieve', () =>
        this.stripe.paymentIntents.retrieve(existing.stripePaymentIntentId),
      )
    } catch (err) {
      this.logger.warn(
        {
          paymentId: existing.id,
          err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
        },
        'payments.intent.replay_retrieve_failed',
      )
      throw new PaymentStripeException('stripe_retrieve_failed')
    }
    return {
      paymentId: existing.id,
      stripePaymentIntentId: existing.stripePaymentIntentId,
      clientSecret: this.requireClientSecret(intent),
      amountAuthorizedCents: existing.amountAuthorizedCents,
      currency: this.assertCurrencyEur(existing.currency),
      status: existing.status,
    }
  }

  private requireClientSecret(intent: Stripe.PaymentIntent): string {
    if (!intent.client_secret) {
      // Cas Stripe rarissime : intent sans clientSecret (compte mal configuré).
      throw new PaymentStripeException('client_secret_missing')
    }
    return intent.client_secret
  }

  /**
   * Le champ `Payment.currency` est typé `string` côté Prisma (default `eur`),
   * mais la vue publique exige le literal `'eur'`. MVP : EUR uniquement
   * (décision CTO Q11) — toute autre valeur en DB serait un bug DB à corriger.
   * On valide tout de même au runtime pour fail-fast (`Q11_INVARIANT`).
   */
  private assertCurrencyEur(raw: string): 'eur' {
    if (raw !== 'eur') {
      throw new Error(`Q11_INVARIANT: currency attendue 'eur', reçue '${raw}'`)
    }
    return 'eur'
  }

  private toClientView(p: Payment): ClientPaymentView {
    return {
      id: p.id,
      missionId: p.missionId,
      stripePaymentIntentId: p.stripePaymentIntentId,
      status: p.status,
      amountAuthorizedCents: p.amountAuthorizedCents,
      amountCapturedCents: p.amountCapturedCents,
      currency: this.assertCurrencyEur(p.currency),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }
  }

  private toAdminView(p: Payment): AdminPaymentView {
    return {
      id: p.id,
      missionId: p.missionId,
      stripePaymentIntentId: p.stripePaymentIntentId,
      status: p.status,
      amountAuthorizedCents: p.amountAuthorizedCents,
      amountCapturedCents: p.amountCapturedCents,
      currency: this.assertCurrencyEur(p.currency),
      applicationFeeCents: p.applicationFeeCents,
      providerPayoutCents: p.providerPayoutCents,
      vatRateSnapshot: p.vatRateSnapshot ? Number(p.vatRateSnapshot) : null,
      // PRD-003 Ticket 3.5 — refunds non encore implémentés en 3.2.
      latestRefundStatus: null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }
  }
}

// Référencé via signature TS — empêche le linter de marquer Mission/Prisma
// imports comme inutilisés si un futur refactor retire un usage local.
export type _PaymentsServiceTypeRefs = Mission | Prisma.TransactionClient
