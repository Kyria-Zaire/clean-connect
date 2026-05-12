# ADR-008 — Escrow Stripe Connect Express : `capture_method='manual'` + delayed transfer

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-008` |
| **Titre** | Mécanique séquestre Clean Connect — autorisation Stripe + transfert différé Connect Express |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` + `stripe` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-003-design-prereview.md` |
| **State machines** | PRD §3.5 livrable 4/5 rev2 (validé CTO 2026-05-12) |

---

## 1. Contexte

PRD-003 introduit un **paiement avec séquestre** : le client paie au moment de réserver la mission ; les fonds restent sur la plateforme tant que le travail n'a pas été validé par le client (ou auto-validé T+48h ouvrées si silence). Stripe Connect Express propose plusieurs modèles d'intégration :

| Modèle Stripe | Mécanique | Adapté à un séquestre ? |
|---|---|---|
| **Direct charges** | Le marchand = prestataire. Page checkout côté prestataire. | ❌ Casse l'UX unifiée Clean Connect + chacun aurait son propre dashboard. |
| **Destination charges** (`transfer_data.destination`) | Charge immédiate côté plateforme, **transfer instantané** Connect au prestataire. | ❌ Transfert trop tôt : on perd le contrôle "validation client". |
| **Separate charges and transfers** | Capture immédiate côté plateforme (capture automatique), `Transfer` séparé après validation. | ⚠️ Fonds prélevés au client dès la commande, treasury sur compte plateforme. Refusé : trop agressif pour le client. |
| **`capture_method='manual'` + delayed transfer** ✅ | Autorisation seulement (pas de débit), capture déclenchée à validation client, `Transfer` Connect ensuite. | ✅ Retenu — débit client uniquement à validation, audit complet, idempotent. |

**Contrainte forte CTO** :
- Plateforme = merchant of record (MVP simplifié — Q6).
- Commission plateforme **18 % HT** snapshotée au paiement (lock-in commission — pas de drift).
- Aucune mission `PUBLISHED` (visible matching) tant que `PaymentStatus != AUTHORIZED`.
- Zéro double capture, zéro double transfer (Verify V2 + V3).

---

## 2. Décision

### 2.1 PaymentIntent — `capture_method='manual'`

1. **Création** : `stripe.paymentIntents.create({ amount, currency: 'eur', customer, capture_method: 'manual', automatic_payment_methods: { enabled: true }, metadata: { missionId, env } }, { idempotencyKey: 'pi-mission-{missionId}-{attempt}' })`. Le client autorise la carte sans débit.
2. **Webhook source de vérité** : `payment_intent.amount_capturable_updated` → `PaymentStatus.AUTHORIZED`, mission `PENDING_PAYMENT → PAID → PUBLISHED`.
3. **Capture** : à validation client (`POST /missions/{id}/validate`) ou au job auto-release T+48h ouvrées. `stripe.paymentIntents.capture(piId, { idempotencyKey: 'capture-mission-{missionId}' })`. **Toujours en queue/job BullMQ retryable** — jamais synchrone dans le handler HTTP (D9).
4. **Transfer Connect** : déclenché **après** confirmation capture (webhook `payment_intent.succeeded`) via `stripe.transfers.create({ amount: providerPayoutCents, destination: prestataire.stripeAccountId, source_transaction: chargeId }, { idempotencyKey: 'transfer-mission-{missionId}' })`. Aucun `transfer_data.destination` au PaymentIntent.

### 2.2 État machines (PRD §3.5 rev2)

- `PaymentStatus` : `AUTHORIZED → CAPTURED → REFUND_PENDING → REFUNDED | FAILED` ; **`AUTHORIZED → CANCELLED`** (capture abandonnée, `payment_intent.canceled` ou `authorization_expired` ~7 j Visa/MC) ; `AUTHORIZED → FAILED` (`payment_intent.payment_failed`).
- `TransferStatus` : `PENDING → SENT | FAILED → RETRY_SCHEDULED → PENDING` (retry idempotent), `SENT → REVERSED` (webhook `transfer.reversed`).
- `AutoReleaseJobStatus` : `SCHEDULED → RUNNING → COMPLETED | FAILED | CANCELLED` (terminaux explicites, renommage `SUCCEEDED → COMPLETED` revue CTO).

### 2.3 Garde-fous obligatoires

1. **Idempotence** sur **toutes** les mutations Stripe : `capture`, `transfer`, `refund`. Clés déterministes `<action>-mission-{missionId}-{attempt}`. **Rétention idempotency-key ≥ 24 h** côté serveur (cf. OpenAPI `IdempotencyKeyHeader`).
2. **Webhook signé** : `stripe.webhooks.constructEvent(rawBody, signature, secret)` **avant** toute désérialisation. Body brut via `RawBodyRequest<Request>`.
3. **Cohérence env** : `assertEnvConsistency(event.livemode === isProdEnv)` — rejet 400 si `sk_test_*` reçoit `livemode=true` ou inverse.
4. **Anti-replay** : `StripeWebhookEvent.stripeEventId` PK + `payloadHash` SHA-256 (détecte tampering payload identique stripeEventId). `409 WEBHOOK_ALREADY_PROCESSED` sur replay.
5. **Verrou applicatif `AutoReleaseJob`** : `lockedAt`/`lockedBy` posés par le worker via `UPDATE ... WHERE locked_at IS NULL` — anti double exécution simultanée BullMQ delayed job + cron horaire safety-net (audit Verify V10).

### 2.4 Cas dégradés

| Cas | Traitement | Code erreur | Audit |
|---|---|---|---|
| `authorization_expired` (~7 j Visa/MC, capture impossible) | `paymentIntents.capture()` renvoie erreur Stripe → audit `CAPTURE_FAILED { reason: 'authorization_expired' }`, mission reste `CLIENT_VALIDATION_PENDING`, alerte ops, **DeadLetter + retry manuel admin** (post-traitement non-MVP : re-authorize flow). | 409 `PAYMENT_AUTHORIZATION_EXPIRED` côté validate client. | `CAPTURE_FAILED` |
| `payment_intent.canceled` (mission `CANCELLED` ou `EXPIRED` côté SYSTEM/BullMQ avant capture) | `PaymentStatus → CANCELLED`. Pas de débit. | — | `PAYMENT_CANCELED` |
| `transfer.failed` (compte Connect désactivé, solde plateforme insuffisant, …) | `TransferStatus → FAILED → RETRY_SCHEDULED → PENDING` (retry exponentiel ≤ 5 tentatives, même `idempotencyKey`). Après 5 tentatives → DLQ `WebhookDeadLetter` + alerte ops. | — | `TRANSFER_FAILED` / `TRANSFER_RETRY_SCHEDULED` |
| `transfer.reversed` (reversal Stripe, compte fermé, fraude) | `TransferStatus → REVERSED`, mission `→ DISPUTE_OPEN`. **Re-transfer manuel hors MVP**. Process litige = PRD-005. | — | `TRANSFER_REVERSED` |
| `charge.refunded` (refund admin réussi) | `RefundStatus → REFUNDED`, `PaymentStatus → REFUNDED`. | — | `REFUND_SETTLED` |
| `charge.refund.updated` failed | `RefundStatus → FAILED`, `PaymentStatus → CAPTURED` (rollback). Retry manuel admin via nouvel `Idempotency-Key`. | — | `REFUND_FAILED` |

### 2.5 Refund (lifecycle dédié)

- Table `Refund` (modèle Prisma) + enum `RefundStatus { PENDING REFUNDED FAILED }`.
- **MVP : refund intégral uniquement** — `Refund.amountCents == Payment.amountCapturedCents` strict. Partial → 422 `PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED`.
- Plusieurs refunds successifs sur même Payment → 409 `PAYMENT_ALREADY_REFUNDED`.
- Idempotence Stripe : `stripe.refunds.create({ payment_intent, amount, reason }, { idempotencyKey: 'refund-mission-{missionId}-{attempt}' })`. Rétention 24 h min.

### 2.6 DLQ replay — ADMIN uniquement

`POST /v1/admin/webhooks/dead-letter/{id}/replay` (`x-rbac: [ADMIN]`). Aucun acteur métier (CLIENT/PRESTATAIRE) n'a accès. Idempotency-Key obligatoire. Traitement async (jobId BullMQ déterministe `dlq-replay-{deadLetterId}`).

### 2.7 Mission expiration — SYSTEM only

`PUBLISHED → EXPIRED` exclusivement déclenchée par cron BullMQ horaire (`mission.expire`) qui scanne `publishedAt + listingTtlHours < now`. **Aucune route HTTP** ne permet à un acteur humain de déclencher cette transition. L'expiration déclenche `paymentIntents.cancel()` → `PaymentStatus → CANCELLED`.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Destination charges** (`transfer_data.destination`) | Transfert instantané côté Connect prestataire au moment du paiement client. Perte du contrôle "validation client / auto-release". Le séquestre devient fictif (les fonds sont déjà chez le prestataire). |
| **Separate charges and transfers** (capture automatique + transfer séparé) | Capture immédiate = débit client à la commande. Trésorerie sur compte plateforme. Refusé pour respect UX client (débit uniquement à validation). |
| **Direct charges** | Marchand = prestataire = chacun a sa propre page checkout Stripe. Casse l'UX unifiée + incompatible "plateforme absorbe les frais Stripe" (D1). |
| **Capture automatique + holding interne** (capture immédiate + on garde sur compte plateforme, transfer plus tard) | Identique à "separate charges and transfers". Mêmes inconvénients (débit immédiat). |
| **`transfer_data.destination` + délai applicatif côté plateforme** | Pas supporté Stripe : le transfer destination est instantané, pas de "delay" natif. |

---

## 4. Conséquences

### Positives

- **UX client juste** : pas de débit tant que le travail n'est pas validé.
- **Audit complet** : `PaymentStatus` + `TransferStatus` + `AutoReleaseJobStatus` + `RefundStatus` séparés, chacun a sa state machine et ses webhooks dédiés.
- **Idempotence par défaut** : chaque mutation Stripe a sa clé déterministe → zéro double capture / double transfer (Verify V2 + V3).
- **Resilience aux retries** : `TransferStatus.RETRY_SCHEDULED` permet de relancer un transfer échoué sans casser l'audit ni dupliquer.
- **Anti-replay webhook** : `StripeWebhookEvent.stripeEventId` PK + `payloadHash` (Verify V1 + V9).

### Négatives / coûts assumés

- **Autorisation Stripe expire ~7 j Visa/MC** : si la capture n'a pas lieu sous 7 j calendaires (cas extrême ponts longs + auto-release T+48 h ouvrées en fin de période), Stripe rejette la capture (`authorization_expired`). Géré par cas dégradé §2.4 — DLQ + retry manuel admin. Hors MVP : re-authorize flow.
- **Latence transfer** : Le prestataire reçoit ses fonds **après** validation client + Transfer Connect (T+48h ouvrées max). Acceptable MVP.
- **Complexité state machines** : 4 enums (`PaymentStatus`, `TransferStatus`, `AutoReleaseJobStatus`, `RefundStatus`) à maintenir cohérents. Tests d'intégration **obligatoires** (Verify V1-V11 + audits A-L).

### Neutres (à surveiller)

- **Treasury Stripe** : les fonds capturés mais pas encore transférés transitent sur le compte plateforme. À monitorer dans le dashboard Stripe (`Available balance` vs `On hold`).
- **Frais Stripe** : la plateforme absorbe les frais (D1). À tracer en métrique Pino `payment.fees_absorbed_cents` pour analyse de marge mensuelle.

---

## 5. Suivi

- [x] State machines mermaid figées dans PRD §3.5 rev2 (livrable 4/5).
- [x] Enums Prisma alignés (`PaymentStatus`, `TransferStatus`, `AutoReleaseJobStatus`, `RefundStatus`).
- [x] Schémas Zod alignés (`@cc/shared-types`).
- [x] OpenAPI contrats explicites (refund 422 partial, webhook 202 async, 409 codes).
- [ ] **Build** : implémentation `PaymentsService.captureAndTransfer()` idempotent, `RefundsService`, `AutoReleaseProcessor`, processors webhook Stripe.
- [ ] **Verify** : audits A-L + V1-V11 (cf. PRD §6.1).
- [x] Mise à jour `.cursor/rules/stripe.mdc` (capture_method manual + idempotence renforcée + table `StripeWebhookEvent`).
- [ ] Métriques Pino : `payment.authorized_count`, `payment.captured_count`, `transfer.sent_count`, `transfer.reversed_count`, `refund.settled_count`, `auto_release.completed_count`.

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §2.2 + §3.5 + §6.1.
- Cahier des charges v1.4 : §4.3 (séquestre), §4.4 (commission).
- Stripe docs :
  - [Manual capture](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) (autorisation différée).
  - [Connect — separate transfers](https://docs.stripe.com/connect/separate-charges-and-transfers).
  - [Authorization expiration](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method#auth-expiration) (~7 j Visa/MC).
- ADRs liées : [ADR-002 montants en centimes](ADR-002-money-in-cents.md), [ADR-011 Stripe API pinning](ADR-011-stripe-api-pinning.md).

---

*ADR-008 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
