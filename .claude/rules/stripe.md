# Stripe Connect Express — Clean Connect

> Activé sur `apps/api/src/modules/payments/**`.
> Cahier des charges : §4.3 et §4.4.

---

## Flow paiement complet

```
1. Client paie une mission
   → PaymentIntent créé avec idempotency_key (clé = mission.id)
   → application_fee_amount = montant × 18 % (commission)
   → transfer_data.destination = stripe_account_id du prestataire (différé)
   → State: SEQUESTRE_BLOQUÉ

2. Prestataire exécute la mission
   → State: EN_COURS → EN_ATTENTE_VALIDATION_CLIENT
   → BullMQ delayed job programmé à T+48h ouvrées : 'auto-release'
   → Rappels push + email programmés à T+24h, T+36h, T+47h

3a. Client valide manuellement
    → stripe.transfers.create() avec idempotency_key
    → State: LIBÉRÉ
    → Job BullMQ 'auto-release' annulé

3b. Pas de réponse à T+48h ouvrées
    → Job 'auto-release' s'exécute
    → Vérifie : photos AVANT sync ? pas de litige ouvert ?
    → Si OK : stripe.transfers.create()
    → State: LIBÉRÉ_AUTO

3c. Client prolonge (avant T+24h)
    → Job 'auto-release' replanifié à T+96h ouvrées
    → State: SEQUESTRE_PROLONGÉ

3d. Client conteste
    → State: LITIGE_OUVERT
    → Job 'auto-release' annulé
    → Process litige (modules/disputes/)
```

---

## Onboarding prestataire — Connect Express

```typescript
async createConnectAccount(userId: string) {
  const user = await this.users.findById(userId)
  if (user.stripeAccountId) return user.stripeAccountId

  const account = await this.stripe.accounts.create({
    type: 'express',
    country: 'FR',
    email: user.email,
    capabilities: {
      transfers: { requested: true },
    },
    business_type: 'individual',
    metadata: { userId, env: env.NODE_ENV },
  })

  await this.users.update(userId, { stripeAccountId: account.id })
  return account.id
}

async createOnboardingLink(userId: string) {
  const accountId = await this.createConnectAccount(userId)
  return this.stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${env.APP_URL}/onboarding/refresh`,
    return_url: `${env.APP_URL}/onboarding/complete`,
    type: 'account_onboarding',
  })
}
```

---

## Création PaymentIntent avec séquestre

```typescript
async createPaymentIntent(mission: Mission) {
  return this.stripe.paymentIntents.create(
    {
      amount: mission.amountCents,
      currency: 'eur',
      customer: mission.client.stripeCustomerId,
      application_fee_amount: Math.round(mission.amountCents * 0.18),
      transfer_data: { destination: mission.prestataire.stripeAccountId },
      capture_method: 'automatic',
      metadata: {
        missionId: mission.id,
        env: env.NODE_ENV,
      },
    },
    { idempotencyKey: `payment-intent-${mission.id}` },
  )
}
```

**Règles dures** :
- `idempotencyKey` Stripe sur **toute** création PaymentIntent / Transfer / Refund
- `application_fee_amount` calculé serveur, **jamais** transmis depuis le client
- `metadata.env` permet de tracer / corréler les events par environnement

---

## Webhooks — événements écoutés

```typescript
const HANDLERS: Record<string, (event: Stripe.Event) => Promise<void>> = {
  'account.updated': handleAccountUpdated,
  'payment_intent.succeeded': handlePaymentSucceeded,
  'payment_intent.payment_failed': handlePaymentFailed,
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'transfer.created': handleTransferCreated,
  'transfer.paid': handleTransferPaid,
  'payout.created': handlePayoutCreated,
  'payout.failed': handlePayoutFailed,
  'radar.early_fraud_warning.created': handleFraudWarning,
  'charge.dispute.created': handleDisputeCreated,
}
```

---

## Vérification webhook — séquence stricte

```typescript
@Post()
@HttpCode(HttpStatus.OK)
async handle(
  @Req() req: RawBodyRequest<Request>,
  @Headers('stripe-signature') signature: string,
) {
  // 1. Signature
  let event: Stripe.Event
  try {
    event = this.stripe.webhooks.constructEvent(req.rawBody, signature, env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    throw new BadRequestException('Invalid signature')
  }

  // 2. Cohérence env
  this.assertEnvConsistency(event)

  // 3. Idempotence
  const exists = await this.prisma.stripeEvent.findUnique({ where: { id: event.id } })
  if (exists) return { received: true, idempotent: true }

  // 4. Enregistrer + enqueue (traitement async)
  await this.prisma.stripeEvent.create({
    data: { id: event.id, type: event.type, payload: event as any, status: 'PENDING' },
  })
  await this.webhookQueue.add('process', { eventId: event.id }, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnFail: false,
  })

  return { received: true }
}

private assertEnvConsistency(event: Stripe.Event) {
  const isLiveEvent = event.livemode
  const isProdEnv = env.NODE_ENV === 'production'
  if (isLiveEvent !== isProdEnv) {
    throw new BadRequestException(`Webhook livemode=${isLiveEvent} mismatches env=${env.NODE_ENV}`)
  }
}
```

---

## Dead Letter Queue (DLQ)

Après 5 retries en échec :

```typescript
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    await this.prisma.webhookDeadLetter.create({
      data: {
        eventId: job.data.eventId,
        error: err.message,
        attempts: job.attemptsMade,
      },
    })
    await this.slack.alert(`Webhook DLQ: ${job.data.eventId} — ${err.message}`)
  }
})
```

**SLA** :
- Détection : 15 min (alerte Slack + email admin)
- Résolution : 4 h ouvrées max
- Dashboard admin avec bouton "Retry manuel" sur chaque entry DLQ

---

## Calcul des heures ouvrées — Europe/Paris

Toutes les dates serveur sont stockées en **UTC** (Postgres `timestamptz`). Les **calculs business** se font en fuseau **Europe/Paris** via `date-fns-tz` + `date-fns-business-days`.

```typescript
// apps/api/src/common/business-time.ts
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz'

const TIMEZONE = 'Europe/Paris'

// Heures ouvrées : Lun-Ven, 9h-18h Europe/Paris, hors jours fériés FR
const FR_HOLIDAYS_2026 = [
  new Date('2026-01-01'), new Date('2026-04-06'), new Date('2026-05-01'),
  new Date('2026-05-08'), new Date('2026-05-14'), new Date('2026-05-25'),
  new Date('2026-07-14'), new Date('2026-08-15'), new Date('2026-11-01'),
  new Date('2026-11-11'), new Date('2026-12-25'),
]

export function addBusinessHoursParis(fromUtc: Date, hours: number): Date {
  let cursor = utcToZonedTime(fromUtc, TIMEZONE)
  let remaining = hours

  while (remaining > 0) {
    if (isBusinessHour(cursor)) {
      cursor = new Date(cursor.getTime() + 3_600_000)
      remaining--
    } else {
      cursor = nextBusinessHourStart(cursor)
    }
  }

  return zonedTimeToUtc(cursor, TIMEZONE)
}

function isBusinessHour(parisDate: Date): boolean {
  const day = parisDate.getDay()
  const hour = parisDate.getHours()
  if (day < 1 || day > 5) return false
  if (hour < 9 || hour >= 18) return false
  return !FR_HOLIDAYS_2026.some(h => isSameDay(h, parisDate))
}
```

**Règles dures** :
- Jamais de calcul d'heures ouvrées en UTC pur (le passage à l'heure d'été décale le résultat)
- Jamais d'arrondi de jour basé sur `setHours(0)` côté serveur sans passer par `utcToZonedTime`
- Table de jours fériés FR mise à jour annuellement (TODO calendrier annuel)

---

## Auto-release — BullMQ delayed job

```typescript
async scheduleAutoRelease(missionId: string) {
  const mission = await this.repo.findById(missionId)
  const releaseAt = addBusinessHoursParis(new Date(), 48)
  const delayMs = releaseAt.getTime() - Date.now()

  await this.escrowQueue.add(
    'auto-release',
    { missionId },
    {
      delay: delayMs,
      jobId: `auto-release-${missionId}`,    // idempotence côté BullMQ
      attempts: 3,
      removeOnComplete: 1000,
    },
  )

  // Rappels programmés
  for (const offsetHours of [24, 36, 47]) {
    const remindAt = addBusinessHours(new Date(), offsetHours)
    await this.notifQueue.add(
      'reminder',
      { missionId, kind: `auto-release-${offsetHours}h` },
      { delay: remindAt.getTime() - Date.now() },
    )
  }
}
```

### Cron de sécurité

Toutes les heures, scan des missions en `EN_ATTENTE_VALIDATION_CLIENT` qui ont dépassé T+48h ouvrées et qui n'ont pas été libérées → tentative de libération + alerte si échec.

---

## Conditions de libération (auto ou manuelle)

```typescript
async canReleaseEscrow(missionId: string): Promise<{ ok: boolean; reason?: string }> {
  const mission = await this.repo.findById(missionId)

  if (mission.status === 'LITIGE_OUVERT') return { ok: false, reason: 'dispute_open' }
  if (mission.escrowStatus === 'RELEASED') return { ok: false, reason: 'already_released' }

  const photosBefore = await this.photos.list(missionId, 'BEFORE')
  const allSynced = photosBefore.every(p => p.syncedAt !== null)
  if (!allSynced) return { ok: false, reason: 'photos_before_not_synced' }

  return { ok: true }
}
```

**Règle dure** : pas de libération si photos AVANT non synchronisées (cahier §4.2 et §5).

---

## Interdictions

- Création PaymentIntent / Transfer sans `idempotencyKey`
- `application_fee_amount` ou destination déterminés côté client
- Webhook sans `constructEvent`
- Body parsé en JSON avant vérification signature
- Mélange env : clé `sk_test_*` sur DB prod ou inverse
- Libération séquestre sans passage par `canReleaseEscrow`
- Logger un PaymentMethod ID brut sans masquage
