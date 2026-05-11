---
name: integrate-external-service
description: Integrate an external HTTP service (Stripe Connect Express, Cloudinary, Firebase Cloud Messaging, SendGrid/Postmark, or any third-party API) in the Clean Connect NestJS backend with mandatory pattern timeout + retry + fallback + structured logging + idempotence. Use when the user asks to call, integrate, query, or wrap an external API, third-party service, payment provider, or notification service.
---

# Intégrer un service externe — Clean Connect

## Pattern obligatoire

```
Timeout → Retry → Idempotence → Fallback → Log
```

Toute intégration externe respecte ce pattern. Aucune exception.

## Squelette générique

```typescript
import { Injectable } from '@nestjs/common'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'

@Injectable()
export class ExternalService {
  constructor(@InjectPinoLogger(ExternalService.name) private readonly logger: PinoLogger) {}

  async callWithRetry<T>(
    fn: () => Promise<T>,
    fallback: () => T | Promise<T>,
    source: string,
    maxAttempts = 3,
  ): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        this.logger.warn({ err, source, attempt }, 'External call retry')
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))   // backoff exp
        }
      }
    }
    this.logger.error({ err: lastErr, source }, 'External call failed, using fallback')
    return fallback()
  }
}
```

## Service-specific

### Stripe (cf `stripe.mdc` pour détails complets)

```typescript
// ✅ idempotencyKey obligatoire sur toute création PaymentIntent/Transfer
const intent = await this.stripe.paymentIntents.create(
  { amount, currency: 'eur', /* ... */ },
  { idempotencyKey: `payment-intent-${mission.id}` },
)
```

**Règles** :
- `stripe.webhooks.constructEvent()` AVANT toute désérialisation
- Cohérence env vérifiée (`event.livemode === isProdEnv`)
- Aucun PaymentMethod ID brut dans les logs

### Cloudinary

```typescript
// Le mobile upload directement à Cloudinary via signed URL
// Le backend signe seulement, ne transite jamais le binaire
const signature = cloudinary.utils.api_sign_request(
  { public_id, timestamp, folder, type: 'private' },
  env.CLOUDINARY_API_SECRET,
)
```

**Règles** :
- `type: 'private'` obligatoire sur photos missions
- Signed URLs expiration ≤ 5 min
- EXIF stripping via upload preset
- Dossier par mission : `${env}/missions/${missionId}/${phase}`

### Firebase Cloud Messaging

```typescript
import { getMessaging } from 'firebase-admin/messaging'

async sendPush(userId: string, payload: PushPayload) {
  const tokens = await this.getActiveTokensForUser(userId)
  if (tokens.length === 0) return

  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data,   // string-only values
  })

  // Nettoyage des tokens invalides
  response.responses.forEach((res, i) => {
    if (!res.success && this.isUnrecoverable(res.error)) {
      this.invalidateToken(tokens[i])
    }
  })
}
```

**Règles** :
- Tokens stockés en DB par utilisateur (multi-device supporté)
- Tokens invalides supprimés immédiatement (`messaging/registration-token-not-registered`)
- Notifications envoyées via BullMQ (pas en synchrone sur l'API)

### Emails (SendGrid / Postmark)

```typescript
async sendTransactional(template: TemplateKey, to: string, vars: Record<string, string>) {
  await this.client.send({
    from: env.EMAIL_FROM,
    to,
    templateId: TEMPLATES[template],
    dynamicTemplateData: vars,
  })
}
```

**Règles** :
- Templates côté provider (pas de HTML dans le code)
- Toujours envoyé via BullMQ (queue `emails`) pour retry + DLQ
- Domain authentication (SPF, DKIM, DMARC) configurée par env

## Idempotence

| Service | Clé d'idempotence |
|---|---|
| Stripe (création) | `idempotencyKey` Stripe = `<entity>-<id>` |
| Stripe (webhook reçu) | `event.id` UNIQUE en DB |
| Cloudinary (upload) | UUID v4 client UNIQUE en DB |
| BullMQ (delayed jobs) | `jobId` explicite (ex: `auto-release-${missionId}`) |

## Configuration Pino redactor

```typescript
{
  redact: [
    'req.headers.authorization',
    'req.headers["stripe-signature"]',
    'req.headers["x-cld-signature"]',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.accessToken',
    '*.cardNumber',
    '*.cvv',
    '*.iban',
    '*.token',
    '*.apiKey',
    '*.fcmToken',
  ],
  censor: '[REDACTED]',
}
```

## BullMQ pour les intégrations

Toute action vers un service externe **non critique pour la réponse HTTP** passe par BullMQ :

```typescript
// ❌ Dans le handler HTTP : appel synchrone à un service externe
async create(dto: CreateMissionDto) {
  const mission = await this.repo.create(dto)
  await this.fcm.sendPush(mission.clientId, { ... })   // bloque la réponse !
  await this.email.sendTransactional(...)              // bloque encore !
  return mission
}

// ✅ Enqueue + retour rapide
async create(dto: CreateMissionDto) {
  const mission = await this.repo.create(dto)
  await this.queue.add('mission.created', { missionId: mission.id })
  return mission
}
```

Le processor BullMQ se charge des notifications, emails, sync, etc., avec retry + DLQ.

## Checklist de fin

- [ ] Timeout configuré (Stripe : par défaut 80s OK, Cloudinary : 30s, FCM : 10s)
- [ ] Retry exponentiel (3-5 tentatives selon criticité)
- [ ] Idempotence (clé adaptée au service)
- [ ] Pino redactor masque les credentials
- [ ] Échec final loggé en `error` + fallback déterministe
- [ ] Action asynchrone enqueuée dans BullMQ (pas synchrone dans HTTP handler)
- [ ] Aucun secret en clair (toujours `env.X`)
- [ ] Test mock fait pour le happy path + un échec
