# ADR-013 — Notifications MVP : Expo push + Resend email + `pushTokens`

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-013` |
| **Titre** | Stack notifications MVP — Expo Push Notifications + Resend email (pas SMS, pas LaunchDarkly) |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` + `mobile` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

PRD-003 décision CTO Q9 (Discover sign-off 2026-05-12) :
- **Push mobile + email transactionnel** dès MVP (pas différé en PRD-004 comme initialement proposé).
- **Pas de SMS** MVP (coût + complexité provider).
- Cas d'usage critiques :
  - Rappels auto-release T+24h/T+36h/T+47h ouvrées (`escrow.reminder`).
  - Mission acceptée / mission rappel.
  - Mission auto-released / fonds transférés.
  - Paiement échoué (retry suggéré).
  - Alertes admin DLQ.

**Stack mobile Clean Connect** : Expo SDK 51 (cf. `mobile.mdc`). Expo offre **Expo Push Notifications** (`expo-notifications`) qui :
- Encapsule APNS (iOS) + FCM (Android) via un proxy Expo (`exp.host/--/api/v2/push/send`).
- Token unique `ExpoPushToken[xxx]` par device.
- Pas besoin de gérer les credentials APNS / firebase-admin côté backend.

---

## 2. Décision

### 2.1 Push mobile via Expo Push Notifications

**Choix retenu** : Expo Push Notifications (proxy Expo) plutôt que FCM/APNS natifs.

Raisons :
- Pas de gestion de credentials APNS (certificats Apple, renouvellement).
- Pas de Firebase Cloud Messaging à configurer côté serveur.
- Un seul SDK côté backend : `expo-server-sdk` (Node).
- DX simple : `expo.sendPushNotificationsAsync([{ to, title, body, data }])`.

### 2.2 Modèle DB — `pushTokens`

```prisma
model PushToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// `ExpoPushToken[xxx]` retourné par `expo-notifications` côté mobile.
  /// UNIQUE par device : si un device s'enregistre 2 fois, on update `updatedAt`.
  token     String   @unique @db.VarChar(255)

  /// `ios` | `android` (sera étendu si web push ajouté plus tard).
  platform  PushPlatform

  /// Désactivé si push fail définitif (`DeviceNotRegistered`) — on garde la ligne pour audit.
  active    Boolean  @default(true)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([userId, active])
  @@map("push_tokens")
}

enum PushPlatform {
  IOS
  ANDROID
}
```

**Endpoints** :
- `POST /v1/me/push-tokens` (CLIENT, PRESTATAIRE) : enregistre / met à jour un token. Body `{ token, platform }`. Idempotent.
- `DELETE /v1/me/push-tokens/{token}` (CLIENT, PRESTATAIRE) : retire un token (logout, désinstallation).

### 2.3 Service NestJS

```typescript
// apps/api/src/modules/notifications/push/push.service.ts
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'

@Injectable()
export class PushService {
  private readonly expo = new Expo({
    accessToken: env.EXPO_ACCESS_TOKEN, // optionnel, augmente la rate-limit Expo
  })

  async sendToUser(userId: string, payload: { title: string; body: string; data?: Record<string, unknown> }) {
    const tokens = await this.prisma.pushToken.findMany({
      where: { userId, active: true },
      select: { token: true },
    })

    const messages: ExpoPushMessage[] = tokens
      .filter(t => Expo.isExpoPushToken(t.token))
      .map(t => ({
        to: t.token,
        sound: 'default',
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        priority: 'high',
        channelId: 'default', // Android channel défini côté mobile
      }))

    if (messages.length === 0) return

    const chunks = this.expo.chunkPushNotifications(messages)
    for (const chunk of chunks) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk)
        await this.handleTickets(tickets, chunk)
      } catch (err) {
        logger.error({ err, userId }, 'push.send.failed')
      }
    }
  }

  private async handleTickets(tickets: ExpoPushTicket[], messages: ExpoPushMessage[]) {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i]
      const message = messages[i]
      if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered') {
          await this.prisma.pushToken.updateMany({
            where: { token: message.to as string },
            data: { active: false },
          })
        }
        logger.warn({ ticket, to: message.to }, 'push.ticket.error')
      }
    }
  }
}
```

**Garde-fous** :
- `Expo.isExpoPushToken(token)` filtre les tokens malformés avant envoi.
- Gestion `DeviceNotRegistered` (désinstallation / token invalide) → `active = false`.
- Logging Pino structuré (`push.send.success`, `push.ticket.error`).

### 2.4 Orchestration via `notifications.module`

```
apps/api/src/modules/notifications/
├── email/                       # ADR-012 (Resend)
│   └── ...
├── push/
│   ├── push.module.ts
│   ├── push.service.ts
│   └── push.client.ts           # ExpoClient + mock dev
├── orchestrator.service.ts      # `notify(user, event, payload)` → choisit canaux (push ∪ email)
└── notifications.module.ts
```

Le service `orchestrator.service.ts` reçoit un event domaine (ex: `MissionAutoReleased`) et :
1. Look-up préférences utilisateur (MVP : tous les canaux actifs par défaut).
2. Render le template email (Resend) + payload push (titre court + body).
3. Envoie en parallèle via `EmailService.send()` + `PushService.sendToUser()`.

### 2.5 Mode dev — mock push

Idem ADR-012 pour email : en `NODE_ENV=development`, on remplace le client Expo par un mock qui log via Pino `push.dev.captured` au lieu d'envoyer réellement.

### 2.6 Pas de SMS / pas de LaunchDarkly MVP

- **SMS** : refus CTO Q9. Coût (~0.05 €/message FR) + complexité Twilio + UX pas critique MVP. Reste éligible PRD-004 si besoin business.
- **LaunchDarkly** : refus CTO Q15. Feature flags via env vars suffisent MVP (`FF_AUTO_RELEASE_ENABLED`, `FF_DISPUTES_ENABLED`, `FF_PAYOUTS_ENABLED`, `FF_PHOTO_GPS_ENFORCEMENT`). Reste éligible PRD-004 si targeting fin.

### 2.7 Variables d'environnement

| Variable | Validation Zod | Exemple |
|---|---|---|
| `EXPO_ACCESS_TOKEN` | `z.string().min(20).optional()` (optionnel — augmente la rate-limit Expo) | `expo_xxxxxxx` |

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **FCM natif** (Firebase Cloud Messaging) | Nécessite `firebase-admin` côté backend + credentials JSON service account. Casse la simplicité Expo. Reste éligible si besoin de features avancées FCM (data-only messages, topic subscriptions). |
| **APNS natif** | Idem FCM, nécessite gestion certificats Apple. Complexité injustifiée MVP. |
| **OneSignal / Pusher** | Provider tiers payant pour features non requises MVP. Lock-in plus fort qu'Expo. |
| **WebSocket / SSE temps réel** | Pertinent pour notif in-app, pas pour réveiller un user fermé. Hors scope MVP push. |
| **SMS via Twilio** | Coût + cas d'usage faible MVP (push couvre les cas urgents). Refus CTO Q9. |

---

## 4. Conséquences

### Positives

- **DX** : Expo + Resend = stack moderne, type-safe, mock dev intégré.
- **Coût MVP** : tier gratuit Expo + Resend ~0 €/mois jusqu'à 100 K notifs/jour.
- **Mobile aligné** : `expo-notifications` natif côté mobile (cf. `mobile.mdc`).
- **Audit** : Pino logs structurés pour chaque envoi + Expo tickets persistables.

### Négatives / coûts assumés

- **Dépendance proxy Expo** : si exp.host down, push impossible. Mitigation : Expo a un bon uptime ; en cas d'incident, on peut basculer à FCM natif (~1 jour de travail).
- **Token expiration** : les tokens Expo peuvent expirer (réinstallation app). Gestion `DeviceNotRegistered` requise — incluse dans `handleTickets`.

### Neutres (à surveiller)

- **Rate limit Expo** : 600 messages/seconde sans `EXPO_ACCESS_TOKEN`, plus avec. À ajuster si volume grandit.
- **Métriques** : `push.send.count`, `push.delivered_count`, `push.failed_count` (Pino + dashboard admin).

---

## 5. Suivi

- [x] PRD §3.4 Q9 + ADRs §4.
- [ ] **Build** : schéma Prisma `PushToken` + enum `PushPlatform` + migration.
- [ ] **Build** : module `notifications/push` + `notifications/email` + `orchestrator.service.ts`.
- [ ] **Build** : routes `POST /v1/me/push-tokens` + `DELETE /v1/me/push-tokens/{token}` (RBAC self).
- [ ] **Build** : intégration dans `escrow.reminder` (T+24h/T+36h/T+47h) + `escrow.auto-release` (event `MissionAutoReleased`) + `payment.failed` (event `PaymentFailed`).
- [ ] **Build** : mock dev push (`tmp/push/...`).
- [ ] **Verify** : test envoi push + email sur user de test + capture mock.

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §3.4 Q9.
- Expo docs : [Push Notifications overview](https://docs.expo.dev/push-notifications/overview/), [Sending notifications](https://docs.expo.dev/push-notifications/sending-notifications/), [expo-server-sdk-node](https://github.com/expo/expo-server-sdk-node).
- ADRs liées : [ADR-012 Email provider Resend](ADR-012-email-provider-resend.md), [ADR-001 Expo managed hybride](ADR-001-expo-managed-hybride.md).

---

*ADR-013 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
