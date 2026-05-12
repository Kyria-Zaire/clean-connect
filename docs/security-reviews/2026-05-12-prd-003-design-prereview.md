# Pré-revue sécurité — Design PRD-003 Photos & Paiements

| Champ | Valeur |
|---|---|
| **Date** | 2026-05-12 |
| **Reviewer** | CTO + `reviewer-securite-code` (méthode pré-revue Design, risques Discover ≥ 4 — sécurité 5/5, RGPD 4/5, financier 5/5) |
| **PRD** | `docs/prd/PRD-003-photos-paiements.md` (Discover validé sign-off CTO 2026-05-12 ; Design rev2 state machines validé CTO 2026-05-12 — livrable 4/5) |
| **Périmètre** | Schéma Prisma + migrations Design + ADR-008 à ADR-013 + OpenAPI `1.0.2-prd003-design-cto-state-machines-rev2` + Zod `@cc/shared-types` + state machines mermaid + rules Cursor (photos-rgpd, stripe) |
| **Statut** | **Pré-revue Design OK — Build interdit sans validation humaine CTO du Design (sign-off final 5/5).** |

---

## Synthèse

| Sévérité | Compte | Commentaire |
|---|---:|---|
| Critical | 0 | — |
| Important | 0 (5 **Conditions Build** documentées §3) | — |
| Suggestion | 3 | Voir §4 |
| Conforme | 22 | Voir §2 |

**Verdict** : aucun blocage **Critical** / **Important** sur le périmètre Design (contrats Zod / OpenAPI / state machines / ADRs). Les 5 conditions §3 sont des garde-fous **obligatoires** à appliquer en Build, déjà tracés en PRD §6 (Verify renforcée 23 audits) — Build peut démarrer après sign-off CTO Design final.

---

## 1. Méthodologie

**Cibles auditées** :
- `docs/prd/PRD-003-photos-paiements.md` — Discover + Design (§2 user stories, §3 décisions CTO + state machines rev2, §4 livrables Design, §6 Verify pré-cadrée).
- `docs/api/PRD-003-openapi.yaml` — 22 endpoints, version `1.0.2-prd003-design-cto-state-machines-rev2` (Redocly lint **0 erreur**).
- `apps/api/prisma/schema.prisma` — modèles `Payment`, `Transfer`, `Refund`, `StripeWebhookEvent`, `WebhookDeadLetter`, `AutoReleaseJob`, `PhotoUploadSession`, `Photo`, `PhotoDeletionLog` ; enums `PaymentStatus`, `TransferStatus`, `RefundStatus`, `AutoReleaseJobStatus`, `StripeWebhookProcessingStatus`, `ProviderPayoutStatus`.
- `apps/api/prisma/migrations/20260512220000_prd003_payment_photo_design/` + `20260512230000_prd003_state_machines_rev2/` — migrations Design.
- `packages/shared-types/src/zod/{payment,photo,webhook,auto-release,mission-workflow,enums}.ts`.
- ADRs : ADR-008 à ADR-013.

**Grille d'audit** : checklist `reviewer-securite-code.mdc` + projet Clean Connect (CLAUDE.md §sécurité + cahier v1.4 §6.4 + §6.5) + skills `review-security-route`, `stripe-escrow-flow`, `offline-sync-pattern`.

**Tests effectués** :
- `pnpm exec redocly lint docs/api/PRD-003-openapi.yaml` → **0 erreur, 0 warning**.
- `pnpm --filter @cc/shared-types typecheck` → **OK**.
- `pnpm --filter @cc/api typecheck` → **OK**.
- `pnpm --filter @cc/api exec prisma generate` → enums + types regen alignés.
- `pnpm --filter @cc/api test` → 104 tests verts (avant Build PRD-003).

---

## 2. Checklist conforme (extraits — 22 items)

### 2.1 Stripe / Paiements (ADR-008, ADR-011)

1. **Idempotence Stripe** : clés déterministes documentées sur **toutes** les mutations (`capture-mission-{id}`, `transfer-mission-{id}`, `refund-mission-{id}-{attempt}`) + rétention idempotency-key **≥ 24 h** (OpenAPI header).
2. **Webhook signé** : `stripe.webhooks.constructEvent` avec `RawBodyRequest<Request>` — séquence obligatoire spécifiée dans rule `stripe.mdc` (signature **avant** désérialisation).
3. **Anti-replay webhook** : `StripeWebhookEvent.stripeEventId` PK + `payloadHash` SHA-256 (détecte tampering identique stripeEventId). `409 WEBHOOK_ALREADY_PROCESSED` (`WebhookErrorCode`).
4. **Cohérence env** : `assertEnvConsistency(event.livemode === isProdEnv)` — rejet 400 (`WEBHOOK_LIVEMODE_MISMATCH`).
5. **Webhook 202 + async** : OpenAPI documente réponse rapide (`WebhookAccepted202Body`), traitement queue BullMQ — Stripe ne timeout pas (audit Verify V1 + V9).
6. **API version pinnée** : `STRIPE_API_VERSION` config-driven (Zod regex validation boot), jamais `latest` — ADR-011.
7. **Lifecycle paiement** : `PaymentStatus` étendu `AUTHORIZED → CAPTURED → REFUND_PENDING → REFUNDED | FAILED | CANCELLED`. `AUTHORIZED → CANCELLED` (authorization_expired ~7j) explicite — ADR-008 + PRD §3.5 rev2.
8. **Lifecycle transfer** : `TransferStatus` étendu `PENDING → SENT | FAILED → RETRY_SCHEDULED → PENDING`, `SENT → REVERSED` — ADR-008. Retry idempotent même `idempotencyKey`.
9. **Lifecycle refund** : `RefundStatus` dédié `PENDING → REFUNDED | FAILED`. **MVP : refund intégral uniquement** (`PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED` 422). Anti double refund (`PAYMENT_ALREADY_REFUNDED` 409) — ADR-008.
10. **AutoReleaseJob terminaux** : `COMPLETED | FAILED | CANCELLED`. Verrou applicatif `lockedAt/lockedBy` anti double exécution (V10) — PRD §3.5 rev2.
11. **DLQ replay ADMIN only** : `POST /v1/admin/webhooks/dead-letter/{id}/replay` `x-rbac: [ADMIN]`. Aucune autre route ne permet à un acteur métier de relancer un job DLQ.
12. **Mission EXPIRED SYSTEM only** : transition `PUBLISHED → EXPIRED` exclusivement déclenchée par cron BullMQ. Pas de route HTTP.
13. **PII finance** : Pino redactor à configurer Build pour `cardNumber`, `cvv`, `stripeAccountId`, `bankAccount.*`, `client_secret` — règle `stripe.mdc`.

### 2.2 Photos / RGPD (ADR-009, ADR-010)

14. **Cloudinary signed upload** : multipart direct mobile → Cloudinary, aucun binaire via API. Signature `stripe.webhooks.constructEvent` équivalent Cloudinary (`x-cld-signature`) avant mutation.
15. **Idempotence upload** : `captureClientUuid` UUID v4 client-generated + `PhotoUploadSession` (TTL 5 min). Anti cross-mission (`PHOTO_UPLOAD_SESSION_MISSION_MISMATCH` 409) + anti cross-session (`PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH` 409). Session expirée → **410** `UPLOAD_SESSION_EXPIRED` (sémantique HTTP correcte).
16. **Dual variant ORIGINAL/DISPLAY** : ORIGINAL audit/litige (ADMIN only), DISPLAY consultation (CLIENT, PRESTATAIRE assigné, ADMIN). Signed URLs ≤ **5 min** (`expires_at`).
17. **EXIF strip côté mobile + Cloudinary** (double sécurité) ; **GPS séparé en DB** (`Photo.gpsLatitude/Lng/AccuracyMeters`, RBAC strict) — ADR-009 + PRD §2.3 D11.
18. **Anti suppression manuelle** : aucune route DELETE publique. `403 PHOTO_DELETION_FORBIDDEN` sur tentative client/prestataire. Suppression admin → `POST /v1/admin/photos/{id}/delete` (Build) — ADR-010.
19. **Rétention 30 j** + cron purge 03h Europe/Paris + skip si dispute actif + **suppression réelle Cloudinary** + `PhotoDeletionLog` audit (`SYSTEM` / `ADMIN`) — ADR-010.

### 2.3 Workflow / RBAC / OpenAPI

20. **RBAC mission completion** : `complete` = PRESTATAIRE only (signale fin) ; `validate` = CLIENT only (déclenche capture+transfer). État `CLIENT_VALIDATION_PENDING` intermédiaire.
21. **GET /missions/:id/payment** : `x-rbac: [CLIENT, ADMIN]` (`oneOf ClientPaymentView | AdminPaymentView` projection déterministe). **Pas de prestataire** sur `/payment` — séparation stricte avec `GET /missions/:id/transfer` (`x-rbac: [PRESTATAIRE, ADMIN]`).
22. **DISPUTE_OPEN transitions** : 3 entrées `CLIENT_VALIDATION_PENDING | AUTO_RELEASE_PENDING | COMPLETED` (sous fenêtre `disputeWindowDays = 7`, sinon 409 `DISPUTE_WINDOW_EXPIRED`). Annule `AutoReleaseJob` en cours.

---

## 3. Conditions Build (à valider en Verify obligatoirement)

| # | Sujet | Détail | Couverture Verify |
|---|---|---|---|
| **CB1** | **Idempotence Stripe** | Implémenter wrapping côté service : `stripe.paymentIntents.create / capture`, `stripe.transfers.create`, `stripe.refunds.create` reçoivent **toujours** un `idempotencyKey` déterministe. Audit code grep CI sur appels Stripe sans `idempotencyKey`. | Audits A + B + V1-V3 (replay webhook, double capture, double payout). |
| **CB2** | **Webhook signature séquence** | Body raw via `RawBodyRequest<Request>`, `constructEvent` avant toute désérialisation. Test d'intégration `signature invalide → 400` (V9 spoofed webhook). Aucun `JSON.parse` avant signature. | Audits D + I + V9. |
| **CB3** | **Verrou AutoReleaseJob** | Implémenter pattern `UPDATE auto_release_jobs SET locked_at=now(), locked_by=$worker WHERE id=$id AND locked_at IS NULL` retournant `RowsAffected = 1` avant exécution. Cron safety-net horaire ne doit jamais exécuter en parallèle du delayed BullMQ. | Audit C + V10 (concurrent auto-release). |
| **CB4** | **Pino redactor étendu** | Ajouter à la config Pino redactor les paths : `*.cardNumber`, `*.cvv`, `*.client_secret`, `*.stripeAccountId`, `*.stripeCustomerId`, `*.bankAccount.*`, `*.token`, `*.captureClientUuid` (potentiel side-channel). Test snapshot logs. | Audit K (Pino redactor). |
| **CB5** | **Cohérence env webhook + clé Stripe** | Au boot, vérifier que `STRIPE_SECRET_KEY` commence par `sk_test_` ssi `NODE_ENV != production`. Crash boot sinon. Au runtime, `assertEnvConsistency(event.livemode)` rejette 400 si mismatch. | Audit E + V9. |

---

## 4. Suggestions (non bloquantes, suivi recommandé)

| # | Suggestion | Suivi |
|---|---|---|
| **S1** | Implémenter une route admin `GET /v1/admin/refunds` (paginée) avec `AdminRefundView` (utilise `RefundStatus`) — actuellement le statut refund est exposé uniquement en `latestRefundStatus` sur `AdminPaymentView`. Améliore l'observabilité côté admin. | Build PRD-003 ou backlog post-MVP. |
| **S2** | Ajouter un test d'intégration `EXPLAIN ANALYZE` sur la requête de matching étendue (`findEligiblePrestataires` avec filtre `providerPayoutStatus = 'READY'`) — vérifier qu'aucune régression d'index vs PRD-002. | Verify PRD-003 perf gate. |
| **S3** | Documenter explicitement dans rule Cursor `notifications.mdc` (à créer Build) la stack push + email + mock dev (ADR-012 + ADR-013) — actuellement implicite via les ADRs. | Build PRD-003 finalisation Notifications. |

---

## 5. Points hors périmètre Design (Build obligatoire)

- Implémentation NestJS modules `PaymentsModule`, `PhotosModule`, `NotificationsModule`, `WebhooksModule`, `AutoReleaseModule`.
- Processors BullMQ : `escrow-auto-release.processor`, `stripe-webhook.processor`, `cloudinary-webhook.processor`, `photos-purge.processor`, `transfer-retry.processor`, `dlq-replay.processor`.
- DTOs `nestjs-zod` + `ZodValidationPipe` global.
- Pino redactor configuration étendue (cf. CB4).
- Mobile : intégration `@stripe/stripe-react-native` (PaymentSheet) + `expo-image-manipulator` (EXIF strip + compress) + `expo-notifications` (push tokens) + file MMKV.
- Smoke test paiement recette + preprod (cartes Stripe 4242 / 3220 / 9995).
- Tests d'intégration 23 audits CTO (12 base A-L + 11 V1-V11).
- Configuration Cloudinary upload preset (`type=private`, `exif=strip`, dossier privé par mission).
- Création des webhooks Stripe (test + live) sur le dashboard avec **la même `apiVersion`** que `STRIPE_API_VERSION`.

---

## 6. Décision de passage Design → Build

| Gate | Statut |
|---|---|
| PRD §4 Design complété (livrables 1/5 à 5/5) | ✅ (livrables 1/5 Prisma + 2/5 Zod + 3/5 OpenAPI rev1 + 4/5 State Machines rev2 + 5/5 ADRs ; sign-off final CTO requis) |
| OpenAPI Redocly lint | ✅ 0 erreur / 0 warning (version `1.0.2-prd003-design-cto-state-machines-rev2`) |
| Zod `@cc/shared-types` typecheck | ✅ |
| Prisma generate + api typecheck | ✅ |
| ADR-008 à ADR-013 rédigés `Accepted` | ✅ |
| Rules Cursor mises à jour (`photos-rgpd.mdc`, `stripe.mdc`) | ✅ (cf. PR #6) |
| Pré-revue reviewer (ce document) | ✅ **Conditions Build CB1-CB5** documentées — Build interdit sans les couvrir en Verify (23 audits A-L + V1-V11). |
| Validation humaine CTO Design final | **En attente sign-off CTO (livrable 5/5)** |

---

*Pré-revue Design — PRD-003 — Clean Connect — BMAD-light phase Design.*
