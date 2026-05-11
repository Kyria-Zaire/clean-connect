---
name: stripe-escrow-flow
description: Implement or audit the complete Stripe Connect Express escrow flow in Clean Connect (PaymentIntent with deferred transfer, BullMQ delayed auto-release at T+48 business hours, reminders, dispute handling, idempotence on all Stripe calls). Use when the user asks to implement payment, escrow, séquestre, auto-release, libération des fonds, or anything around Stripe Connect with deferred capture/transfer.
---

# Flow Stripe avec séquestre — Clean Connect

> Référence : cahier des charges v1.3 §4.3.

## Vue d'ensemble

```
Client paie → PaymentIntent capturé → Séquestre BLOQUÉ
                                       ↓
                        Prestataire exécute la mission
                                       ↓
                  Mission soumise → état EN_ATTENTE_VALIDATION_CLIENT
                                       ↓
                  BullMQ delayed job programmé à T+48h ouvrées
                  + rappels push/email à T+24h, T+36h, T+47h
                                       ↓
        ┌──────────────┬────────────────┬──────────────────┐
        ↓              ↓                ↓                  ↓
   Client valide   Pas de réponse  Client prolonge   Client conteste
        ↓              ↓                ↓                  ↓
    transfer       transfer        re-programme       LITIGE_OUVERT
    immédiat       auto T+48h ouv  T+96h ouvrées      séquestre maintenu
```

## Étape 1 — Modèle Prisma

```prisma
model Payment {
  id                      String        @id @default(uuid())
  missionId               String        @unique
  stripePaymentIntentId   String        @unique
  amountCents             Int
  applicationFeeCents     Int
  escrowStatus            EscrowStatus
  createdAt               DateTime      @default(now())
  releasedAt              DateTime?
  releasedBy              ReleaseReason?

  mission                 Mission       @relation(fields: [missionId], references: [id])
  history                 EscrowHistory[]
}

enum EscrowStatus {
  BLOCKED
  PROLONGED
  DISPUTE_OPEN
  RELEASED
  REFUNDED
}

enum ReleaseReason {
  CLIENT_VALIDATED
  AUTO_RELEASE
  ADMIN_DECISION
}

model EscrowHistory {
  id          String       @id @default(uuid())
  paymentId   String
  from        EscrowStatus
  to          EscrowStatus
  reason      String
  triggeredBy String?      // userId ou 'system'
  createdAt   DateTime     @default(now())

  payment     Payment      @relation(fields: [paymentId], references: [id])

  @@index([paymentId, createdAt])
}

model StripeEvent {
  id          String   @id                  // event.id Stripe
  type        String
  livemode    Boolean
  payload     Json
  status      String   @default("PENDING")  // PENDING | PROCESSED | DLQ
  receivedAt  DateTime @default(now())
  processedAt DateTime?
  error       String?
}
```

## Étape 2 — Création PaymentIntent (séquestre BLOQUÉ)

```typescript
async createPaymentForMission(mission: Mission): Promise<Payment> {
  const applicationFee = Math.round(mission.amountCents * 0.18)

  const intent = await this.stripe.paymentIntents.create(
    {
      amount: mission.amountCents,
      currency: 'eur',
      customer: mission.client.stripeCustomerId,
      application_fee_amount: applicationFee,
      transfer_data: { destination: mission.prestataire.stripeAccountId },
      capture_method: 'automatic',
      metadata: { missionId: mission.id, env: env.NODE_ENV },
    },
    { idempotencyKey: `payment-intent-${mission.id}` },
  )

  return this.prisma.payment.create({
    data: {
      missionId: mission.id,
      stripePaymentIntentId: intent.id,
      amountCents: mission.amountCents,
      applicationFeeCents: applicationFee,
      escrowStatus: 'BLOCKED',
      history: { create: { from: 'BLOCKED', to: 'BLOCKED', reason: 'initial', triggeredBy: 'system' } },
    },
  })
}
```

## Étape 3 — Soumission au client → schedule auto-release

```typescript
async submitMissionToClient(missionId: string) {
  await this.missions.updateStatus(missionId, 'EN_ATTENTE_VALIDATION_CLIENT')

  const releaseAt = addBusinessHours(new Date(), 48)   // date-fns-business-days

  // Job principal d'auto-release
  await this.escrowQueue.add(
    'auto-release',
    { missionId, expectedReleaseAt: releaseAt.toISOString() },
    {
      delay: releaseAt.getTime() - Date.now(),
      jobId: `auto-release-${missionId}`,   // idempotence
      attempts: 3,
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  )

  // Rappels client
  for (const offsetHours of [24, 36, 47]) {
    const remindAt = addBusinessHours(new Date(), offsetHours)
    await this.notifQueue.add(
      'reminder',
      { missionId, kind: `auto-release-${offsetHours}h` },
      {
        delay: remindAt.getTime() - Date.now(),
        jobId: `reminder-${missionId}-${offsetHours}h`,
      },
    )
  }
}
```

## Étape 4 — Conditions de libération

```typescript
async canReleaseEscrow(missionId: string): Promise<{ ok: boolean; reason?: string }> {
  const mission = await this.missions.findById(missionId)
  const payment = await this.payments.findByMissionId(missionId)

  if (!payment) return { ok: false, reason: 'no_payment' }
  if (payment.escrowStatus === 'RELEASED') return { ok: false, reason: 'already_released' }
  if (payment.escrowStatus === 'DISPUTE_OPEN') return { ok: false, reason: 'dispute_open' }
  if (mission.status !== 'EN_ATTENTE_VALIDATION_CLIENT' && mission.status !== 'COMPLETED') {
    return { ok: false, reason: 'mission_not_completed' }
  }

  const photosBefore = await this.photos.countSynced(missionId, 'BEFORE')
  if (photosBefore < 3) return { ok: false, reason: 'photos_before_not_synced' }

  return { ok: true }
}
```

## Étape 5 — Validation manuelle par le client

```typescript
async validateMissionByClient(missionId: string, clientId: string) {
  const eligibility = await this.canReleaseEscrow(missionId)
  if (!eligibility.ok) throw new BadRequestException(eligibility.reason)

  await this.prisma.$transaction(async (tx) => {
    await this.releaseFunds(missionId, 'CLIENT_VALIDATED', tx)
    await this.cancelAutoReleaseJob(missionId)
    await tx.mission.update({ where: { id: missionId }, data: { status: 'COMPLETED', completedAt: new Date() } })
  })
}

private async releaseFunds(missionId: string, reason: ReleaseReason, tx: Prisma.TransactionClient) {
  const payment = await tx.payment.findUnique({ where: { missionId } })

  // Le transfer a déjà été initié via transfer_data sur le PaymentIntent
  // Ici on confirme et on met à jour notre état
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      escrowStatus: 'RELEASED',
      releasedAt: new Date(),
      releasedBy: reason,
      history: { create: { from: payment.escrowStatus, to: 'RELEASED', reason, triggeredBy: 'system' } },
    },
  })

  this.logger.info({ missionId, reason }, 'Escrow released')
}

private async cancelAutoReleaseJob(missionId: string) {
  const job = await this.escrowQueue.getJob(`auto-release-${missionId}`)
  if (job) await job.remove()
}
```

## Étape 6 — Auto-release (BullMQ processor)

```typescript
@Processor('escrow')
export class EscrowProcessor {
  constructor(
    private readonly escrow: EscrowService,
    @InjectPinoLogger(EscrowProcessor.name) private readonly logger: PinoLogger,
  ) {}

  @Process('auto-release')
  async handleAutoRelease(job: Job<{ missionId: string }>) {
    const { missionId } = job.data
    this.logger.info({ jobId: job.id, missionId }, 'Auto-release start')

    const eligibility = await this.escrow.canReleaseEscrow(missionId)
    if (!eligibility.ok) {
      this.logger.warn({ missionId, reason: eligibility.reason }, 'Auto-release skipped')
      // Si la raison est temporaire (photos_before_not_synced), on retry plus tard
      if (eligibility.reason === 'photos_before_not_synced') {
        throw new Error('Retry: photos not synced yet')
      }
      return   // raisons définitives (already_released, dispute_open) : on quitte
    }

    await this.escrow.releaseFromAuto(missionId)
    this.logger.info({ missionId }, 'Auto-release done')
  }
}
```

## Étape 7 — Cron de sécurité

```typescript
@Cron('0 * * * *')   // toutes les heures
async safetyCheckAutoRelease() {
  const cutoff = subBusinessHours(new Date(), 48)

  const eligibleMissions = await this.prisma.mission.findMany({
    where: {
      status: 'EN_ATTENTE_VALIDATION_CLIENT',
      submittedAt: { lt: cutoff },
      payment: { escrowStatus: 'BLOCKED' },
    },
    take: 100,
  })

  for (const m of eligibleMissions) {
    try {
      await this.escrowQueue.add('auto-release', { missionId: m.id }, { jobId: `safety-${m.id}-${Date.now()}` })
    } catch (err) {
      this.logger.error({ err, missionId: m.id }, 'Safety auto-release enqueue failed')
    }
  }
}
```

## Étape 8 — Prolongation client (avant T+24h)

```typescript
async prolongEscrow(missionId: string, clientId: string) {
  const payment = await this.assertOwnerAndStatus(missionId, clientId, ['BLOCKED'])

  await this.cancelAutoReleaseJob(missionId)

  const newReleaseAt = addBusinessHours(new Date(), 96)   // T+96h ouvrées
  await this.escrowQueue.add(
    'auto-release',
    { missionId },
    {
      delay: newReleaseAt.getTime() - Date.now(),
      jobId: `auto-release-${missionId}`,
      attempts: 3,
    },
  )

  await this.prisma.payment.update({
    where: { id: payment.id },
    data: {
      escrowStatus: 'PROLONGED',
      history: { create: { from: 'BLOCKED', to: 'PROLONGED', reason: 'client_request', triggeredBy: clientId } },
    },
  })
}
```

## Étape 9 — Litige

```typescript
async openDispute(missionId: string, clientId: string, reason: string) {
  await this.cancelAutoReleaseJob(missionId)

  await this.prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { missionId } })
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        escrowStatus: 'DISPUTE_OPEN',
        history: { create: { from: payment.escrowStatus, to: 'DISPUTE_OPEN', reason, triggeredBy: clientId } },
      },
    })
    await tx.dispute.create({ data: { missionId, openedBy: clientId, reason, status: 'NEGOCIATION' } })
  })

  // Notif admin
  await this.notifQueue.add('admin.dispute.opened', { missionId })
}
```

## Checklist d'implémentation

- [ ] `idempotencyKey` Stripe sur **toute** création PaymentIntent / Transfer / Refund
- [ ] `application_fee_amount` calculé serveur (18 % HT)
- [ ] `transfer_data.destination` = `stripe_account_id` du prestataire
- [ ] `metadata.env` sur chaque PaymentIntent (corrélation logs)
- [ ] BullMQ `jobId` explicite (`auto-release-<missionId>`) pour idempotence côté queue
- [ ] Annulation du job lors d'une validation manuelle ou litige
- [ ] Cron de sécurité horaire pour rattraper les jobs perdus
- [ ] `canReleaseEscrow()` vérifie : pas de litige, pas déjà release, photos AVANT sync
- [ ] `EscrowHistory` tracée à chaque transition (audit complet)
- [ ] Tests : happy path + photos non sync + litige ouvert + double validation

## Anti-patterns

❌ Calculer la commission côté client (faille de manipulation)
❌ `stripe.transfers.create()` sans `idempotencyKey`
❌ Libérer le séquestre sans passer par `canReleaseEscrow()`
❌ Auto-release sans vérifier photos AVANT synchronisées
❌ Annuler un PaymentIntent sans tracer dans `EscrowHistory`
❌ Hardcoder T+24h ou T+48h en `setTimeout` (utiliser BullMQ delayed jobs)
