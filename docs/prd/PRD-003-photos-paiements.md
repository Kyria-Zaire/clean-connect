# PRD-003 — Photos AVANT/APRÈS + Stripe Connect Express (Escrow)

> **PRD** = *Product Requirements Document*
> Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) §4.3 & §4.4 (paiements / escrow / commission), §5 (mode offline photos), §6.4 (sécurité photos), §6.5 (RGPD).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).
> Dépendances : [PRD-001 Auth JWT](PRD-001-auth-jwt.md) ✅ `DONE`, [PRD-002 Missions & Géolocalisation](PRD-002-missions-geolocalisation.md) ✅ `RELEASED`.

> **Statut** : ✅ **DISCOVER_DONE** — sign-off CTO 2026-05-12 (cf. §3.6). Design ouvert sur `design/prd-003-photos-paiements`.

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-003` |
| **Slug** | `photos-paiements` |
| **Titre** | Photos AVANT/APRÈS + Stripe Connect Express (escrow) — sous-systèmes Media Evidence / Payment Lifecycle / Mission Completion / Stripe Connect Onboarding |
| **Version PRD** | `0.2` (Discover validé) |
| **Statut** | `DISCOVER_DONE` (sign-off CTO 2026-05-12) → ouverture Design |
| **Owner produit** | CTO Clean Connect |
| **Owner technique** | `senior-dev` (cadrage) → `architecte-api` + `securite` + `stripe` + `photos-rgpd` (Design) |
| **Persona pilote Discover** | `senior-dev` |
| **Créé le** | 2026-05-12 |
| **Mis à jour le** | 2026-05-12 |
| **Cible de release** | MVP Sprint 3 (~3 semaines après validation Design) |
| **T-shirt size** | **XL** (4 sous-systèmes critiques sécurité + finance + RGPD ; risque Stripe ≥ 4 ⇒ pré-revue `reviewer-securite-code` Design + Verify renforcée) |
| **Lien Cahier v1.4** | §4.3 séquestre, §4.4 commission, §5 mode offline, §6.4 sécurité photos, §6.5 RGPD |

---

## 1. Contexte & problème

### 1.1 Pourquoi cette feature ?

Sans paiement et sans preuve photo, **la valeur produit n'est ni monétisable ni vérifiable** :
- aucun cash flow (les missions PRD-002 sont gratuites en l'état) ;
- aucune confiance entre client et prestataire (pas de preuve de l'état AVANT/APRÈS) ;
- aucune protection en cas de litige ;
- les obligations légales (TVA, comptabilité, RGPD) ne peuvent pas démarrer.

PRD-003 ferme cette boucle : **le client paie, les fonds sont mis en séquestre, le prestataire prouve son travail (photos AVANT/APRÈS), les fonds sont libérés** vers le compte Connect du prestataire (T+48h ouvrées si silence client, immédiat si validation manuelle).

### 1.2 Personas concernés

- [x] **Client** — paie via Stripe Checkout / PaymentSheet, valide ou laisse auto-release.
- [x] **Prestataire** — onboarde son compte Stripe Connect Express, upload photos AVANT/APRÈS, reçoit les fonds nets.
- [x] **Admin interne** — peut consulter les paiements, ouvrir manuellement un litige, retry une DLQ webhook.
- [x] **Système** — webhooks Stripe + Cloudinary, jobs BullMQ (auto-release, rappels, purge photos, retry transfers).

### 1.3 Métriques de succès

| Métrique | Baseline actuelle | Cible MVP | Comment mesurer |
|---|---|---|---|
| Taux de paiement réussi (PaymentIntent succeeded / created) | N/A | ≥ 95 % | Pino event `payment.intent.succeeded` / `payment.intent.created` |
| Taux d'onboarding Stripe Connect complété | N/A | ≥ 70 % à J+7 d'inscription prestataire | webhook `account.updated` + `capabilities.transfers === 'active'` |
| Taux de mission `COMPLETED` (vs ACCEPTED) | N/A | ≥ 80 % | event `mission.completed` / `mission.accepted` |
| Taux d'auto-release T+48h sans litige | N/A | ≥ 60 % | event `escrow.auto_released` / total releases |
| Latence p95 photo upload (mobile → URL signée Cloudinary OK) | N/A | < 8 s sur 4G | OpenTelemetry span `photos.signed_url.served` |
| Webhook DLQ rate (Stripe + Cloudinary) | N/A | < 0.5 % | jobs `webhookDeadLetter` / total webhooks |
| Conflit de double capture / double transfer | 0 | **0** (zéro tolérance) | Audit `mission_events` + Stripe Dashboard |

### 1.4 Out of scope (refusé MVP — ne pas dériver)

- ❌ Multi-prestataires sur une même mission (pas de partage de pot).
- ❌ Litiges complexes / arbitrage / remboursement partiel (placeholder seulement, vrai workflow = **PRD-005**).
- ❌ Facturation PDF automatique (le reçu Stripe email suffit MVP).
- ❌ Commission dynamique (fixe **18 %** comme PRD-002 §4.4 cahier v1.4).
- ❌ Avoirs / wallet / crédit utilisateur.
- ❌ Multi-currency (EUR only MVP).
- ❌ Smart retries / dunning paiement échoué (le client doit ré-essayer manuellement).
- ❌ Pourboires.
- ❌ KYC/AML enrichi côté plateforme (délégué à Stripe Connect Express, on consomme `requirements`).
- ❌ Modération automatique des photos (pas de NSFW scan MVP — on fait confiance + on a la preuve audit).
- ❌ Vidéo, plans 3D, scan AR.
- ❌ Géofencing strict du provider (pas de blocage si la photo a une lat/lng éloignée — on logue, on ne bloque pas MVP).

---

## 2. User stories & critères d'acceptance

### 2.1 Sous-système A — Stripe Connect Onboarding (Prestataire)

**En tant que** prestataire nouvellement inscrit
**Je veux** lier mon compte bancaire via Stripe Connect Express
**Pour** pouvoir recevoir mes paiements après mes missions

- [ ] **AC-A.1** — POST `/payments/connect/onboarding-link` (PRESTATAIRE) crée un compte `account.type='express'` (ou réutilise s'il existe) et retourne un `accountLink.url` (TTL Stripe, généralement 5 min).
- [ ] **AC-A.2** — Webhook `account.updated` met à jour `users.stripeAccountId`, `users.stripeChargesEnabled`, `users.stripeTransfersEnabled`, `users.stripePayoutsEnabled`, `users.stripeRequirementsCurrentlyDue` (JSON), et **calcule** un enum dérivé **`ProviderPayoutStatus`** (cf. décision CTO Q7) avec valeurs : `NOT_ONBOARDED | ONBOARDING_IN_PROGRESS | IDENTITY_PENDING | PAYOUTS_DISABLED | CHARGES_DISABLED | READY`. Une seule colonne dénormalisée à filtrer dans le matching.
- [ ] **AC-A.3** — Un prestataire dont `providerPayoutStatus !== 'READY'` ne peut **pas** apparaître dans le matching (extension du filtre `findEligiblePrestataires` PRD-002 §3) — clause `WHERE providerPayoutStatus = 'READY'` ajoutée au matching.
- [ ] **AC-A.4** — Un prestataire `providerPayoutStatus !== 'READY'` qui tente d'`accept` une mission reçoit `403 PRESTATAIRE_PAYMENT_NOT_READY` avec `reason` détaillé (`onboarding_incomplete | payouts_disabled | charges_disabled | identity_pending`).
- [ ] **AC-A.5** — Le compte Stripe est créé avec `metadata: { userId, env: NODE_ENV }`, `business_type: 'individual'` (par défaut MVP), `country: 'FR'`.

**Cas d'erreur à couvrir** :
- [ ] Mobile retry POST onboarding-link → renvoie le **même** account si déjà créé (idempotence côté DB sur `users.stripeAccountId`).
- [ ] Webhook `account.updated` reçu hors-ordre (ex: après `account.application.deauthorized`) → on prend toujours le state Stripe le plus récent (refetch via API si doute).

---

### 2.2 Sous-système B — Payment Lifecycle (PaymentIntent + Escrow)

**En tant que** client ayant accepté un devis (mission acceptée par un prestataire)
**Je veux** payer la mission de manière sécurisée
**Pour** réserver le créneau et libérer les fonds quand le travail est validé

- [ ] **AC-B.1** — Le paiement intervient **avant publication** (cf. décision CTO Q4 + D15 modifié) : `DRAFT → PENDING_PAYMENT → PAID → PUBLISHED`. Aucune mission n'est exposée au matching tant qu'elle n'est pas `PAID` (i.e. `paymentStatus = AUTHORIZED` côté Stripe).
- [ ] **AC-B.2** — POST `/payments/missions/:id/intent` (CLIENT owner) crée un PaymentIntent **`capture_method='manual'`** (cf. décision CTO Q1, ADR-008) avec `automatic_payment_methods.enabled=true` (3DS automatique, cf. Q8) + **idempotency-key serveur déterministe** = `pi-mission-${missionId}-${attemptNumber}`. Retourne `clientSecret`.
- [ ] **AC-B.3** — Mécanique « escrow » (wording produit à adapter, ce n'est pas un escrow légal cf. ADR-008) = **`capture_method='manual'` + delayed transfer** : autorisation au paiement, capture déclenchée à validation client (ou auto-release T+48h ouvrées), Transfer Stripe Connect ensuite vers le prestataire. Pas de `transfer_data.destination` au PaymentIntent.
- [ ] **AC-B.4** — Le `application_fee_amount` (commission 18 % HT) est **calculé serveur**, jamais transmis depuis le client (cf. règle `stripe`).
- [ ] **AC-B.5** — Webhook `payment_intent.amount_capturable_updated` (= autorisation OK) → `paymentStatus: AUTHORIZED`, mission passe à `PAID → PUBLISHED`, audit `MissionEvent { type: 'PAYMENT_AUTHORIZED' }`. Aucune transition basée sur la confirmation **front** (frontend says success ≠ source de vérité).
- [ ] **AC-B.6** — Webhook `payment_intent.payment_failed` → mission reste `PENDING_PAYMENT` (cf. Q4 + D15 corrigé), audit `PAYMENT_FAILED`. Le client peut ré-essayer (nouvelle attempt → idempotency-key change `attemptNumber`). Pas de smart retries (Q5).
- [ ] **AC-B.7** — `PaymentStatus` lifecycle complet en DB : `PENDING → AUTHORIZED → CAPTURED → RELEASE_PENDING → RELEASED → REFUNDED | DISPUTED | FAILED` avec contraintes de transitions strictes (machine d'état dédiée, pattern PRD-002). État `AUTHORIZED` = autorisation Stripe valide mais non capturée (capture déclenchée à validation client / auto-release).
- [ ] **AC-B.8** — Tous les events Stripe `payment_intent.*`, `charge.*`, `transfer.*`, `payout.*`, `account.updated`, `charge.dispute.*`, `radar.early_fraud_warning.*` sont écoutés et persistés en table dédiée **`StripeWebhookEvent`** (cf. D19) avec colonnes `stripeEventId UNIQUE / type / payloadHash (sha256) / processedAt / status`. Déduplication par `stripeEventId UNIQUE`. `payloadHash` permet de détecter une re-livraison Stripe avec payload divergent (tampering / bug).
- [ ] **AC-B.9** — Aucune mutation Stripe créée sans `idempotencyKey` (D18 renforcement) : `capture`, `refund`, `transfer`, traitement webhook (job BullMQ `jobId` déterministe). Format clé : `<action>-<missionId>-<attempt>`.
- [ ] **AC-B.10** — Un PaymentIntent ne peut être créé deux fois pour la même mission tant que le précédent est en `PENDING / AUTHORIZED / CAPTURED` (contrainte DB UNIQUE conditionnel + service).
- [ ] **AC-B.11** — `assertEnvConsistency(event.livemode === isProdEnv)` rejette tout webhook qui mélange test/live (ex: clé `sk_test_*` reçoit un event `livemode=true`).
- [ ] **AC-B.12** — Stripe SDK initialisé avec `apiVersion = env.STRIPE_API_VERSION` (cf. Q12 + ADR-011) — version pinnée explicitement, jamais `latest`. Bumps tracés via ADR.

**Cas d'erreur à couvrir** :
- [ ] Webhook reçu avec signature invalide → 400, jamais traité.
- [ ] Webhook reçu en doublon (Stripe re-essaie) → renvoyer 200 idempotent sans rejouer la mutation.
- [ ] PaymentIntent qui succeed alors que la mission a entre-temps été cancelled → trigger un refund automatique + alerte admin.
- [ ] `charge.dispute.created` → mission passe en `DISPUTED`, blocage de tout `transfer` (audit `DISPUTE_OPENED`).
- [ ] `radar.early_fraud_warning.created` → log + alerte admin (pas de bloquage automatique MVP).

---

### 2.3 Sous-système C — Media Evidence System (Photos AVANT/APRÈS)

**En tant que** prestataire sur le terrain
**Je veux** prendre et uploader des photos AVANT et APRÈS la mission
**Pour** prouver mon travail et débloquer le paiement

- [ ] **AC-C.1** — POST `/photos/sign` (PRESTATAIRE assigné de la mission) retourne une signature Cloudinary signed upload + un `cloudinaryPublicId` calculé serveur (`<env>/missions/<missionId>/<phase>/<uuid>`).
- [ ] **AC-C.2** — **Le binaire ne transite jamais par l'API NestJS** — upload **multipart direct** mobile → Cloudinary (cf. décision CTO D16). **Interdit : base64 uploads** (mémoire mobile + bande passante + charge serveur).
- [ ] **AC-C.3** — Idempotence : la même `uuid` (UUID v4 généré côté mobile **avant** capture) renvoyée 2× → 1 seul enregistrement DB (UNIQUE constraint), même `cloudinaryPublicId`.
- [ ] **AC-C.4** — Cloudinary upload preset force : `type=private, exif=strip` (anti-fuite GPS device).
  - **Original sécurisé** conservé (sans transformation, pour audit/litige) — public_id `<env>/missions/<missionId>/<phase>/<uuid>/original` (cf. décision CTO D17).
  - **Version compressée display** dérivée Cloudinary à la volée (`f_auto, q_auto, w_1600`) accessible aux clients via signed URL — public_id `<env>/missions/<missionId>/<phase>/<uuid>/display`.
  - Les deux versions partagent le même `Photo.id` côté DB, distinguées par enum `PhotoVariant` (`ORIGINAL | DISPLAY`).
- [ ] **AC-C.5** — Metadata DB **obligatoires** : `missionId`, `phase` (enum strict `PhotoPhase`: `BEFORE | AFTER` cf. D20), `uploadedBy`, `uploadedAt`, `clientLat?`, `clientLng?`, `clientGpsAccuracyMeters?`, `gpsMissing` (boolean, cf. Q3), `clientCheckSumSha256`, `cloudinaryPublicId`.
- [ ] **AC-C.6** — Webhook Cloudinary `notification_type=upload` met à jour `photos.status=UPLOADED`, `photos.syncedAt`, `photos.bytes`, `photos.width`, `photos.height` après vérification signature `x-cld-signature`.
- [ ] **AC-C.7** — **Minimum bloquant** (cf. décision CTO) :
  - **3 photos `BEFORE` synchronisées** sont nécessaires pour passer la mission `PAID → IN_PROGRESS`.
  - **5 photos `AFTER` synchronisées** sont nécessaires pour passer la mission `IN_PROGRESS → CLIENT_VALIDATION_PENDING`.
- [ ] **AC-C.8** — GET `/photos/:id/signed-url` (RBAC : owner CLIENT, prestataire assigné, ADMIN) renvoie une signed URL Cloudinary `expires_at = now + 5min`.
- [ ] **AC-C.9** — **Aucune suppression manuelle** par client/prestataire avant expiration de la rétention (HTTP 403 sur DELETE jusqu'à T+30j post-completion + hors litige actif).
- [ ] **AC-C.10** — Job cron quotidien `photos.purge` supprime le blob Cloudinary à T+30j post `mission.completedAt` (ligne DB conservée avec `cloudinaryPublicId='__deleted__'` pour audit). **Skip** si litige actif.

**Cas d'erreur à couvrir** :
- [ ] Mobile offline → file MMKV + retry exponentiel (PRD-002 déjà couvert par dette `debt-matching-async-queue` mais ici c'est pour photos, déjà spécifié dans skill `offline-sync-pattern`).
- [ ] Mobile envoie 3 BEFORE + 4 AFTER puis essaie de valider → 409 `MISSION_PHOTOS_INSUFFICIENT { required: { before: 3, after: 5 }, got: { before: 3, after: 4 } }`.
- [ ] Webhook Cloudinary signature invalide → 400, photo reste `PENDING_UPLOAD` (cron de réconciliation peut interroger Cloudinary plus tard).
- [ ] Client tente de DELETE photo après mission COMPLETED mais avant T+30j → 403 `PHOTO_DELETE_FORBIDDEN_RETENTION`.

---

### 2.4 Sous-système D — Mission Completion Workflow

**En tant que** client
**Je veux** voir les photos APRÈS et valider la fin de mission (ou laisser le système valider après T+48h ouvrées)
**Pour** que le prestataire reçoive son paiement

- [ ] **AC-D.1** — La machine d'état mission est étendue (extension de PRD-002) avec les états **payment-aware** (cf. §3.4 ci-dessous).
- [ ] **AC-D.2** — POST `/missions/:id/start` (PRESTATAIRE assigné) → `PAID → IN_PROGRESS` **uniquement si** ≥ 3 photos `BEFORE` synchronisées (vérifié serveur, pas client).
- [ ] **AC-D.3** — POST `/missions/:id/finish` (PRESTATAIRE assigné) → `IN_PROGRESS → CLIENT_VALIDATION_PENDING` **uniquement si** ≥ 5 photos `AFTER` synchronisées.
- [ ] **AC-D.4** — Sur `CLIENT_VALIDATION_PENDING`, le système programme :
  - 1 job BullMQ delayed `escrow.auto-release` à `addBusinessHoursParis(now, 48)` (Europe/Paris, jours fériés FR exclus).
  - 3 jobs delayed `notif.reminder` à T+24h, T+36h, T+47h ouvrées (push FCM **+** email Resend cf. Q9 + Q10).
- [ ] **AC-D.5** — POST `/missions/:id/validate` (CLIENT owner) → `CLIENT_VALIDATION_PENDING → COMPLETED` immédiat. Déclenche en séquence dans une **queue/job** (jamais synchrone, cf. Q1 + D9) : (1) `paymentIntents.capture()` avec `idempotencyKey = capture-mission-${missionId}`, (2) Transfer Stripe Connect avec `idempotencyKey = transfer-mission-${missionId}`. Annule le job `escrow.auto-release`.
- [ ] **AC-D.6** — Job `escrow.auto-release` : revalide les invariants (`canReleaseEscrow`) → si OK : capture + transfer + `AUTO_RELEASED → COMPLETED`. Sinon : audit `AUTO_RELEASE_BLOCKED` + alerte admin (ne change pas le state).
- [ ] **AC-D.7** — Cron horaire de **sécurité** `escrow.safety-net` : scanne les missions en `CLIENT_VALIDATION_PENDING` qui ont dépassé `now + 48h ouvrées + 1h marge` et n'ont pas été libérées (delayed job perdu) → tentative + alerte si échec.
- [ ] **AC-D.8** — `canReleaseEscrow(missionId)` vérifie : (a) mission status ∈ `{ CLIENT_VALIDATION_PENDING, AUTO_RELEASE_PENDING }`, (b) ≥ 3 photos BEFORE syncées, (c) ≥ 5 photos AFTER syncées, (d) pas de litige `DISPUTE_OPEN`, (e) `paymentStatus = AUTHORIZED` (autorisation Stripe encore valide, pas expirée), (f) prestataire `providerPayoutStatus = 'READY'`.
- [ ] **AC-D.9** — POST `/missions/:id/dispute` (CLIENT owner, fenêtre = T+48h ouvrées max après `CLIENT_VALIDATION_PENDING`) → `DISPUTE_OPEN`, annulation job `escrow.auto-release`, audit `DISPUTE_OPENED { reason }`. Process litige détaillé = **PRD-005**.

**Cas d'erreur à couvrir** :
- [ ] Concurrence : 2 POST `/finish` simultanés du même prestataire → un seul gagne (lock optimiste UPDATE conditionnel pattern PRD-002).
- [ ] Race `validate` vs `auto-release` : un seul transfer Stripe créé (idempotency-key déterministe = `transfer-mission-${missionId}` ⇒ Stripe garantit pas de double transfer même si on appelle 2x).
- [ ] `auto-release` qui échoue côté Stripe (compte Connect désactivé entre temps) → audit `AUTO_RELEASE_FAILED { stripeError }` + alerte admin, mission reste `CLIENT_VALIDATION_PENDING`, retry manuel possible.
- [ ] Webhook `transfer.failed` ou `payout.failed` reçu après transfer → audit + alerte, état mission ne régresse pas (le problème est côté Stripe → admin).

---

## 3. Phase DISCOVER

### 3.1 Risk assessment

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| **Sécurité** | **5/5** | Argent en jeu, secrets Stripe, webhooks signés, prévention double capture/payout, validation signature Cloudinary, signed URLs courte durée. | Pré-revue `reviewer-securite-code` Design + Verify renforcée (5 audits CTO minimum, cf. §6 Verify pré-cadré). |
| **RGPD** | **4/5** | Photos = données personnelles (lieu de vie client), nouvelle politique rétention 30j (vs 12 mois `photos-rgpd.mdc`), droit à l'effacement à étendre, compliance EXIF strip. | Mise à jour règle `.cursor/rules/photos-rgpd.mdc` (rétention 30j) + ADR + référent RGPD interne. |
| **Financier (escrow)** | **5/5** | Double capture / double payout = catastrophe (perte cash). Idempotency keys obligatoires sur **toutes** les mutations Stripe. Cohérence env test/live (clé `sk_test_*` ≠ DB prod). | Application stricte rule `stripe`. Smoke test post-déploiement obligatoire en Verify. |
| **UX (régression)** | 3/5 | Le workflow paiement insère 3 nouveaux écrans mobile (Stripe PaymentSheet + photos AVANT + photos APRÈS + validation). Risque de friction, pas critique fonctionnel. | Tests E2E happy path Detox + monitoring drop-off mobile. |
| **Performance** | 3/5 | Upload photos peut être lent en 4G (compression mobile + CDN), webhooks doivent rester < 200ms (handlers async via BullMQ). | Pas d'action spéciale au-delà des règles standard (signed URL court, Cloudinary CDN). |
| **Disponibilité (Stripe + Cloudinary)** | **4/5** | Stripe down = paiement impossible. Cloudinary down = photos impossibles → mission bloquée. | Plan B : (a) PaymentIntent en queue de retry si Stripe 5xx, (b) photos en file MMKV mobile + retry, (c) status page Stripe surveillée + dashboard admin "incidents en cours". |

**Conclusion risk assessment** : 3 domaines ≥ 4 ⇒ **pré-revue `reviewer-securite-code` OBLIGATOIRE en Design** + **Verify renforcée** (5 audits CTO minimum, comme PRD-002 mais étendus paiement).

### 3.2 Modules touchés

- [x] `apps/api/src/modules/payments/` — **NOUVEAU** : Stripe Connect Express, PaymentIntents, Transfers, escrow state machine, webhooks Stripe.
- [x] `apps/api/src/modules/photos/` — **NOUVEAU** : signed URL upload, webhook Cloudinary, ownership, retention.
- [x] `apps/api/src/modules/missions/` — **EXTENSION** : nouveaux états (cf. §3.5 v0.2 : `PENDING_PAYMENT / PAID / IN_PROGRESS / CLIENT_VALIDATION_PENDING / AUTO_RELEASE_PENDING / AUTO_RELEASED / COMPLETED / DISPUTE_OPEN / REFUNDED`), hooks photo count, filtre `providerPayoutStatus = 'READY'` dans `findEligiblePrestataires`.
- [x] `apps/api/src/modules/notifications/` — **NOUVEAU module minimal** (cf. décision CTO Q9) : rappels **push FCM + email Resend** à T+24h/T+36h/T+47h ouvrées. Le module complet (templates riches, in-app, settings utilisateur) reste dans le scope **PRD-004**.
- [x] `apps/api/src/modules/disputes/` — **PLACEHOLDER** : route POST `/missions/:id/dispute` qui passe en `DISPUTE_OPEN`. Vrai workflow = **PRD-005**.
- [x] `apps/api/src/queue/processors/` — **NOUVEAU** : `escrow-auto-release.processor.ts`, `stripe-webhook.processor.ts`, `cloudinary-webhook.processor.ts`, `photos-purge.processor.ts`.
- [x] `apps/mobile/src/features/payments/` — **NOUVEAU** : intégration `@stripe/stripe-react-native` (PaymentSheet), écrans onboarding Connect, écrans validation client.
- [x] `apps/mobile/src/features/photos/` — **NOUVEAU** : capture (expo-camera), compression (expo-image-manipulator 1600px qualité 75), file MMKV, sync background (expo-task-manager + expo-background-fetch).
- [x] `apps/admin/src/pages/payments/` — **NOUVEAU** : dashboard paiements + webhook DLQ + retry manuel.
- [x] `packages/shared-types/src/zod/` — **EXTENSION** : `payment.ts`, `photo.ts`, états mission étendus.
- [x] `apps/api/prisma/schema.prisma` — **EXTENSION** : `Payment`, `StripeEvent`, `Photo`, `WebhookDeadLetter`, extension `User` (champs Stripe), extension `Mission` (états + relations).
- [x] Configuration / infra / CI : nouveaux env vars Stripe + Cloudinary, secrets manager, webhook endpoint exposé HTTPS (ngrok/cloudflare en dev, vrai domaine en preprod/prod).

### 3.3 Open questions — toutes `RESOLVED` (sign-off CTO 2026-05-12)

> Décisions CTO **déjà tranchées** au brief d'ouverture sont consignées en §3.4 ci-dessous (D1-D15).
> Ce tableau liste les **15 questions résiduelles** soulevées en Discover, **toutes tranchées** par le CTO le 2026-05-12.

| # | Question | Décision CTO finale | Statut | Note Design |
|---|---|---|:-:|---|
| **Q1** | Mécanique escrow exacte | **`capture_method='manual'` + delayed transfer**. Pas d'escrow légal, **wording produit à adapter**. Pas de destination charges immédiates, pas d'automatic transfer, pas de payout synchrone. **ADR-008 obligatoire**. | ✅ `RESOLVED` | ⚠️ Garde-fou Design : autorisation Stripe Visa/MC expire ~7 jours. Auto-release T+48h ouvrées tient (~5j calendaires max ponts longs). À documenter en limite produit ADR-008. |
| **Q2** | Rétention photos | **30 jours par défaut** (`defaultRetentionDays = 30`). Exceptions : litige, fraude, obligation légale/comptable. **ADR-010 + maj `.cursor/rules/photos-rgpd.mdc`**. | ✅ `RESOLVED` | Rétention basée sur `mission.completedAt` ; reset si `dispute.openedAt` actif (cron skip si litige). |
| **Q3** | GPS obligatoire ? | **Oui mais tolérance contrôlée** : photos BEFORE/AFTER → GPS fortement recommandé. Si absent : mission possible mais `gpsMissing = true` + flag review interne potentiel. **Pas de hard-block MVP** (Android perms, parking souterrain, edge cases). | ✅ `RESOLVED` | DB : champs `clientLat/Lng` nullable, `gpsMissing` boolean dérivé. |
| **Q4** | Placement de PAID dans le workflow | **PAID AVANT intervention/publication** : `DRAFT → PENDING_PAYMENT → PAID → MISSION_PUBLISHED`. Jamais de mission publiée sans paiement autorisé. **Très important business**. | ✅ `RESOLVED` | ⚠️ **Refonte machine d'état mission** vs §3.5 v0.1. Voir §3.5 v0.2 ci-dessous. |
| **Q5** | Qui valide la mission ? | **Le CLIENT valide**. Flow : `AFTER_UPLOADED → CLIENT_VALIDATION_PENDING → COMPLETED` (validation manuelle), ou sinon `AUTO_RELEASE_PENDING → AUTO_RELEASED → COMPLETED` (T+48h ouvrées). | ✅ `RESOLVED` | UI mobile : bouton "Valider la mission" côté CLIENT. Côté prestataire : pas de bouton de release. |
| **Q6** | Merchant of record | **MVP : la plateforme est merchant of record**. Simplifie Stripe / UX / remboursements / support. | ✅ `RESOLVED` | Reçu Stripe = Clean Connect. Le prestataire reçoit ses fonds via Transfer Connect uniquement. |
| **Q7** | Onboarding strict prestataire | **Oui : strict**. Le provider ne peut PAS accepter de mission si Connect onboarding incomplet, payouts disabled, charges disabled, identity pending. **Créer enum `ProviderPayoutStatus`**. | ✅ `RESOLVED` | Cf. AC-A.2 / AC-A.3 / AC-A.4. Filtre matching dénormalisé pour perf. |
| **Q8** | 3DS | **Stripe automatique**. Aucune logique custom MVP. Utiliser **`automatic_payment_methods.enabled = true`**. | ✅ `RESOLVED` | Inclus dans la création PaymentIntent (AC-B.2). |
| **Q9** | Notifications | **Push mobile + email transactionnel minimal**. Pas SMS MVP. | ✅ `RESOLVED` | ⚠️ Le scope MVP intègre **FCM + email** dès PRD-003 (au lieu de différer FCM en PRD-004 comme proposé Discover). À planifier en Build : module `notifications` minimal au moins pour les rappels auto-release. |
| **Q10** | Email provider | **Resend** ([resend.com](https://resend.com)) — DX excellente, React Email, setup rapide. | ✅ `RESOLVED` | ADR-011 ajusté : tracer choix Resend + comparer Postmark/SendGrid en alternative refusée §8.2. |
| **Q11** | Currency | **EUR uniquement MVP**. Stockage : **integer cents** (toujours). | ✅ `RESOLVED` | Aligné PRD-002 (`estimatedPriceCents`). |
| **Q12** | Stripe API version | **Version figée**. Jamais `latest`. **Créer `STRIPE_API_VERSION` dans config**. **ADR-011 (Stripe API pinning)** recommandé. | ✅ `RESOLVED` | ⚠️ Ajustement ADR : ADR-011 traite **Stripe API pinning**, ADR-012 traite **Email provider Resend** (réorganisation §4 ci-dessous). |
| **Q13** | Geofencing photos | **Soft geofencing MVP** : comparer photo gps vs mission gps ; si distance > seuil → `flagSuspicious = true`. **Ne pas bloquer automatiquement**. | ✅ `RESOLVED` | Seuil par défaut à fixer Design (proposition senior-dev : 500 m). |
| **Q14** | TVA | **Hors scope MVP**. Stocker seulement **`vatRateSnapshot`** sur la mission/payment pour usage futur (facturation auto, exports compta). **Pas de moteur TVA MVP**. | ✅ `RESOLVED` | Champ `Payment.vatRateSnapshot Decimal?` ; pas de logique de répartition HT/TTC MVP. |
| **Q15** | Feature flags | **Oui** au minimum sur : `auto release`, `disputes`, `payouts`, `GPS enforcement`. **Via env/config simple**. Pas LaunchDarkly MVP. | ✅ `RESOLVED` | Variables : `FF_AUTO_RELEASE_ENABLED`, `FF_DISPUTES_ENABLED`, `FF_PAYOUTS_ENABLED`, `FF_PHOTO_GPS_ENFORCEMENT`. Validées Zod boot. |

> ✅ **Toutes les Open Questions sont `RESOLVED`** — sign-off CTO 2026-05-12. Discover validé, Design ouvert.

### 3.4 Décisions CTO déjà tranchées (consolidées du message d'ouverture)

> Ce sont les décisions CTO **fermes** issues du brief Sprint 3. Aucune ré-discussion en Design sauf si conflit majeur découvert.

| # | Sujet | Décision CTO |
|---|---|---|
| D1 | Commission Stripe | ✅ La **plateforme absorbe les frais Stripe**. Commission Clean Connect = **18 % HT**. Le prestataire reçoit son net après commission. |
| D2 | Stockage photos | ✅ **Cloudinary signed upload** (pas S3 brut). Direct mobile → Cloudinary, jamais via API. |
| D3 | Rétention photos | ✅ **30 jours** post `mission.completedAt` (sauf litige actif / réclamation / obligation légale). Job de purge programmé. |
| D4 | Photos AVANT obligatoires | ✅ Minimum **3 photos BEFORE** pour démarrer (`PAID → IN_PROGRESS`), minimum **5 photos AFTER** pour finir (`IN_PROGRESS → CLIENT_VALIDATION_PENDING`). Sinon : pas de transition, pas de payout, pas de validation. |
| D5 | Auto-release | ✅ **48h ouvrées** (Europe/Paris, jours fériés FR exclus). `date-fns-business-days` + `date-fns-tz`. BullMQ delayed jobs + cron de sécurité horaire. |
| D6 | Échec paiement | ✅ Pas de smart retries / dunning MVP. Mission reste à l'état pré-paiement, le client doit ré-essayer manuellement. |
| D7 | Webhooks Stripe | ✅ Signature **obligatoire** (`stripe.webhooks.constructEvent` avec `req.rawBody`). Reject si invalide. Idempotence par `stripe_events.id` UNIQUE en DB. Cohérence env strict (`event.livemode === isProd`). |
| D8 | Stripe Connect | ✅ **Express** (pas Custom). Onboarding via `accountLinks`. KYC délégué Stripe. |
| D9 | Pas de payout synchrone | ✅ Jamais `validate → instant transfer` côté HTTP handler. Toujours via **queue/job retryable + idempotent**. |
| D10 | Lifecycle paiement | ✅ Enum `PaymentStatus` : `PENDING / AUTHORIZED / CAPTURED / RELEASE_PENDING / RELEASED / REFUNDED / FAILED / DISPUTED`. Machine d'état dédiée, pattern PRD-002. |
| D11 | Metadata photos obligatoires | ✅ `missionId`, `phase` (BEFORE/AFTER), `uploadedBy`, `timestamp`, `lat/lng` (envoyés par mobile, **séparés de l'EXIF**), `checksumSha256`, `cloudinaryPublicId`. |
| D12 | Suppression photos | ❌ **Aucune suppression manuelle** par client ni prestataire avant expiration de la rétention. |
| D13 | Source de vérité paiement | ✅ **Webhook Stripe = vérité**. Jamais `frontend says payment success` → side effect serveur. |
| D14 | Idempotency keys Stripe | ✅ Obligatoires sur **toutes** les mutations : capture, transfer, refund, payout. Format déterministe `<action>-<missionId>-<attempt>`. |
| D15 | Mission completion workflow | ✅ États : `DRAFT / PENDING_PAYMENT / PAID / PUBLISHED / ACCEPTED / IN_PROGRESS / CLIENT_VALIDATION_PENDING / AUTO_RELEASE_PENDING / AUTO_RELEASED / COMPLETED / DISPUTE_OPEN / REFUNDED / CANCELLED / EXPIRED`. **Important** : `PAID` intervient **avant** `PUBLISHED` (cf. décision Q4 — corrige la version v0.1 du PRD qui plaçait `PAID` après `ACCEPTED`). Voir §3.5 schéma v0.2. |
| **D16** | Uploads photos | ✅ **Interdiction des base64 uploads**. Uniquement **multipart direct signed upload** mobile → Cloudinary. |
| **D17** | Conservation des images | ✅ Toujours conserver **2 versions** : (a) **original sécurisé** (sans transformation, audit/litige), (b) **version compressée** (display, partagée via signed URL). Enum `PhotoVariant: ORIGINAL | DISPLAY`. |
| **D18** | Idempotence renforcée | ✅ Idempotency keys **obligatoires** sur : `capture`, `refund`, `transfer`, **traitement webhook** (job BullMQ `jobId` déterministe). |
| **D19** | Table StripeWebhookEvent | ✅ Table dédiée **`StripeWebhookEvent`** avec colonnes : `stripeEventId UNIQUE`, `type`, `payloadHash` (sha256), `processedAt`, `status`. **Critique anti-replay**. |
| **D20** | Enums photo stricts | ✅ Enum Prisma stricts pour `PhotoPhase` (`BEFORE | AFTER`) — **pas de string libre**. Idem pour `PhotoVariant`, `PhotoStatus`, `PaymentStatus`, `ProviderPayoutStatus`. |
| **D21** | Verify renforcé — 11 scénarios obligatoires | ✅ PRD-003 doit **inclure** ces tests Verify : (1) replay webhook, (2) double capture, (3) double payout, (4) upload sans auth, (5) upload cross-mission, (6) upload AFTER sans BEFORE, (7) payout disabled provider, (8) expired PaymentIntent, (9) spoofed webhook, (10) concurrent auto-release, (11) concurrent refund/capture. Cf. §6.1. |

### 3.5 Machine d'état mission étendue v0.2 (PAID avant PUBLISHED — décision CTO Q4)

> Extension du `mission-state.machine.ts` PRD-002. Le détail typing + assertions sera figé en Design.
> ⚠️ **v0.2 corrige v0.1** suite à la décision CTO Q4 : PAID intervient **avant** publication, jamais de mission visible sans paiement autorisé.

```
   DRAFT ──submit──→ PENDING_PAYMENT ──payment_intent.amount_capturable_updated──→ PAID
                          │                                                            │
                          │                                                  publish (auto)
                          ▼ payment_intent.payment_failed (reste PENDING_PAYMENT)      ▼
                          │                                                       PUBLISHED
                          └── retry (nouveau attempt)                                  │
                                                                                accept (PRESTATAIRE READY)
                                                                                       ▼
                                                                                   ACCEPTED
                                                                                       │
                                                                            start (≥ 3 BEFORE syncées)
                                                                                       ▼
                                                                                IN_PROGRESS
                                                                                       │
                                                                            finish (≥ 5 AFTER syncées)
                                                                                       ▼
                                                                       CLIENT_VALIDATION_PENDING
                                                                            │              │
                                                                  validate (CLIENT)        silence T+48h ouvrées
                                                                            │              ▼
                                                                            │     AUTO_RELEASE_PENDING
                                                                            │              │
                                                                            │     escrow.auto-release job
                                                                            │     (capture + transfer)
                                                                            │              ▼
                                                                            │       AUTO_RELEASED
                                                                            ▼              │
                                                                       COMPLETED ◀─────────┘
                                                                            │
                                                                            └── (rare) ── REFUNDED

   À tout moment depuis CLIENT_VALIDATION_PENDING (fenêtre T+48h ouvrées max) :
   ──── dispute (CLIENT) ────→ DISPUTE_OPEN (process PRD-005)

   À tout moment avant ACCEPTED :
   ──── cancel (CLIENT) ────→ CANCELLED (refund auto si paiement déjà autorisé)

   À tout moment depuis PUBLISHED (avant ACCEPTED) :
   ──── expire (TTL listing dépassé) ────→ EXPIRED (refund auto)
```

**Règles dures associées** :
- Aucune transition non listée n'est autorisée (extension PRD-002 `assertMissionTransition`).
- Une mission ne devient `PUBLISHED` (= visible matching) que si `paymentStatus = AUTHORIZED` (Stripe a autorisé la carte).
- Tout `cancel` ou `expire` après `PAID` déclenche un `paymentIntents.cancel()` (libère l'autorisation Stripe avant capture) — pas de capture, pas de refund nécessaire.
- Tout passage par `payments.captureAndTransfer()` est **idempotent** (keys déterministes `capture-mission-${id}` + `transfer-mission-${id}`).
- Tout passage en `COMPLETED` doit avoir `paymentStatus ∈ { RELEASED, AUTO_RELEASED }` ET `≥ 5 photos AFTER syncées` ET `≥ 3 photos BEFORE syncées` ET pas de `DISPUTE_OPEN`.
- Une transition `CLIENT_VALIDATION_PENDING → DISPUTE_OPEN` annule le job BullMQ `escrow.auto-release` (jobId déterministe `auto-release-${missionId}`).
- L'extension du matching PRD-002 ajoute **deux** filtres : `mission.status = 'PUBLISHED'` ET `prestataire.providerPayoutStatus = 'READY'`.

### 3.6 Definition of Done — Discover ✅

- [x] PRD instancié avec ID, slug, statut `DISCOVER_DONE`
- [x] Lien explicite vers cahier v1.4 §4.3, §4.4, §5, §6.4, §6.5
- [x] User stories couvrant **les 4 sous-systèmes** (A Onboarding Connect / B Payment Lifecycle / C Photos / D Completion Workflow) avec critères d'acceptance testables
- [x] Risk assessment renseigné (3 domaines ≥ 4 ⇒ pré-revue sécu Design + Verify renforcée)
- [x] Métriques de succès quantifiables
- [x] Out of scope explicite (12 items)
- [x] Décisions CTO déjà tranchées consolidées (**21 items** D1-D21, dont 6 ajoutées au sign-off)
- [x] Machine d'état mission étendue v0.2 figée (PAID avant PUBLISHED — sera typée Design via ADR)
- [x] T-shirt size estimé (XL)
- [x] **15 Open Questions résiduelles toutes `RESOLVED`** (sign-off CTO 2026-05-12)
- [x] **Validation humaine (Owner produit CTO)** : 2026-05-12

> ✍️ **Validé Discover par CTO le 2026-05-12.** Statut → `DISCOVER_DONE`. Passage autorisé en Design (cf. message CTO `Décision CTO finale ✅ Discover PRD-003 validé. ✅ Open questions résolues. ✅ PR #5 approuvée pour merge. ✅ Passage autorisé au Design Sprint 3.`).

---

## 4. Phase DESIGN — ouverte (sign-off CTO Discover 2026-05-12)

**Branche** : `design/prd-003-photos-paiements`.

**Livrables attendus** :

1. **Schéma Prisma** complet :
   - `Payment` (relations Mission, lifecycle `PaymentStatus`, `vatRateSnapshot Decimal?`)
   - `StripeWebhookEvent` (cf. D19 : `stripeEventId UNIQUE`, `type`, `payloadHash`, `processedAt`, `status`)
   - `WebhookDeadLetter` (jobs en échec après 5 retries)
   - `Photo` (UUID v4, `PhotoPhase`, `PhotoVariant ORIGINAL | DISPLAY` cf. D17, `PhotoStatus`, metadata GPS nullable + `gpsMissing`, `flagSuspicious`, checksum sha256, retention)
   - Extension `User` : `stripeAccountId`, `stripeChargesEnabled`, `stripeTransfersEnabled`, `stripePayoutsEnabled`, `stripeRequirementsCurrentlyDue Json`, **`providerPayoutStatus ProviderPayoutStatus`** (D7+Q7)
   - Extension `Mission` : nouveaux états (cf. §3.5 v0.2), index sur `(status, providerPayoutStatus)` pour matching extension, `paymentId` FK
   - Tous les enums Prisma stricts (D20)
2. **Schémas Zod** dans `packages/shared-types/src/zod/payment.ts`, `photo.ts`, états mission étendus, validation env vars (`STRIPE_API_VERSION`, secrets Cloudinary, Resend, FCM, FF_*).
3. **Contrat API** complet : chaque route avec verbe / auth / RBAC / ownership / idempotency-key / rate limit / codes HTTP.
4. **State machine paiement** dédiée (`payment-state.machine.ts`) + extension `mission-state.machine.ts`, assertions strictes (pattern PRD-002).
5. **ADRs à rédiger** :
   - **ADR-008** — Mécanique « escrow » : `capture_method='manual'` + delayed transfer Stripe Connect Express. Limites (autorisation expire ~7j Visa/MC), trade-offs vs destination/separate charges, wording produit. ✅ tranché Q1.
   - **ADR-009** — Cloudinary signed upload (multipart direct, pas de base64) + EXIF strip + lat/lng séparé en DB + dual variant (ORIGINAL + DISPLAY). ✅ tranché D2+D16+D17+Q3.
   - **ADR-010** — Politique rétention photos 30 jours (remplace mention 12 mois `photos-rgpd.mdc`) + exceptions litige/fraude/légal. ✅ tranché Q2.
   - **ADR-011** — Stripe API pinning (`STRIPE_API_VERSION` config-driven, jamais `latest`). ✅ tranché Q12.
   - **ADR-012** — Email provider Resend (vs SendGrid/Postmark, alternatives refusées dans §8.2). ✅ tranché Q10.
   - **ADR-013** — Notifications minimales MVP : push FCM + email Resend (pas SMS). ✅ tranché Q9.
6. **Mise à jour règles Cursor** :
   - `.cursor/rules/photos-rgpd.mdc` : rétention 12 mois → 30 jours + dual variant ORIGINAL/DISPLAY + interdiction base64.
   - `.cursor/rules/stripe.mdc` : remplacer `transfer_data.destination` (Destination charges) par `capture_method='manual'` + delayed transfer + idempotence renforcée + table `StripeWebhookEvent` (au lieu de `stripeEvent`).
7. **Plan de tests** détaillé (unit / intégration / E2E mobile / sécu / perf / smoke paiement avec cartes test 3DS / non-3DS / refusée).
8. **Rollout** : feature flags D15+Q15 (`FF_AUTO_RELEASE_ENABLED`, `FF_DISPUTES_ENABLED`, `FF_PAYOUTS_ENABLED`, `FF_PHOTO_GPS_ENFORCEMENT`) + plan de rollback (désactivation flag → coupure chaîne sans rollback migration).
9. **Pré-revue `reviewer-securite-code` OBLIGATOIRE** sur le Design (risque ≥ 4 sur sécu/finance/RGPD) avant validation CTO Design.

**DoD Design** : cf. template PRD §4.9 + sign-off CTO + rapport pré-revue sécurité joint.

---

## 5. Phase BUILD

⛔ Bloquée tant que Design non validé CTO. **Aucune migration `schema.prisma`, aucun code, aucun PR Build avant validation Design.**

**Garde-fous attendus pour Build** (anticipation rule `senior-dev` / `architecte-api` / `securite` / `stripe` / `photos-rgpd`) :
- Webhook Stripe : signature **AVANT** désérialisation, raw body via `RawBodyRequest<Request>`.
- Webhook Cloudinary : signature `x-cld-signature` vérifiée AVANT mutation.
- Idempotency keys déterministes sur **toutes** les mutations Stripe.
- Aucun `application_fee_amount` ni `transfer.destination` calculé côté client.
- Cron de sécurité `escrow.safety-net` horaire.
- BullMQ DLQ avec alertes.
- Logger Pino redactor étendu (`*.cardNumber`, `*.cvv`, `*.stripeAccountId`, `*.stripeCustomerId`, `*.bankAccount.*`).
- Soft-launch derrière `FF_PAYMENTS_ENABLED`.

---

## 6. Phase VERIFY (pré-cadrée — discipline renforcée vs PRD-002)

> Comme indiqué par le CTO, le risque ≥ 4 impose une discipline Verify **encore plus stricte** qu'au Sprint 2. Pré-définition des audits dès Discover pour qu'on sache où on va.

### 6.1 Audits CTO obligatoires anticipés (à figer Design / Build)

> **23 audits** au total : 12 audits techniques de base (A-L) + **11 scénarios supplémentaires CTO obligatoires (V1-V11)** mandatés au sign-off Discover (D21).

#### 6.1.1 Audits techniques de base (A-L)

| # | Audit | Risque cible |
|---|---|---|
| **A** | Idempotence webhook Stripe (replay 10× même `stripeEventId`) | Pas de double mutation, pas de double transfer |
| **B** | Idempotence Stripe API mutations (capture, transfer, refund) — replay même `idempotencyKey` | Stripe garantit pas de duplication |
| **C** | Race validate vs auto-release (CLIENT POST `/validate` simultané au job BullMQ) | Un seul couple capture+transfer Stripe créé |
| **D** | Webhook Stripe signature invalide (forge HMAC) → rejet 400 | Aucun event traité |
| **E** | Cohérence env (event `livemode=true` reçu sur DB test) → rejet | Pas de pollution croisée |
| **F** | Photos count validation (2 BEFORE / 4 AFTER → 409 INSUFFICIENT) | Pas de bypass |
| **G** | Suppression photo manuelle pré-rétention → 403 | Pas de purge prématurée |
| **H** | Signed URL Cloudinary expire bien à 5min | Pas d'URL longue |
| **I** | Webhook Cloudinary signature invalide → rejet | Pas de mutation depuis source non vérifiée |
| **J** | DLQ webhook (échec 5 retries) → alerte admin + entry en `WebhookDeadLetter` | Pas de perte silencieuse |
| **K** | Pino redactor étendu vérifie absence de `cardNumber`, `cvv`, `stripeAccountId`, `bankAccount.*` dans tous les logs | Pas de PII finance |
| **L** | RGPD : DELETE `/users/me` purge bien les photos uploadées (sauf litige actif) à T+30j | Droit à l'effacement respecté |

#### 6.1.2 Scénarios supplémentaires CTO mandatés (V1-V11) — décision D21

| # | Scénario | Couverture attendue |
|---|---|---|
| **V1** | **Replay webhook** : injecter 5× le même payload Stripe avec `stripeEventId` identique | 1 seule mutation, 4 réponses idempotentes 200, table `StripeWebhookEvent` ne contient qu'une seule entrée |
| **V2** | **Double capture** : POST `/missions/:id/validate` 2× simultanés du CLIENT | 1 seul `paymentIntents.capture()` Stripe (idempotency-key déterministe), pas de double prélèvement |
| **V3** | **Double payout** : trigger 2× le job BullMQ `escrow.auto-release` pour la même mission | 1 seul Transfer Stripe créé (idempotency-key + lock optimiste DB) |
| **V4** | **Upload sans auth** : POST `/photos/sign` sans JWT | 401 |
| **V5** | **Upload cross-mission** : prestataire X tente d'uploader sur mission acceptée par prestataire Y | 403 `PHOTO_NOT_OWNED_MISSION` |
| **V6** | **Upload AFTER sans BEFORE** : tenter `POST /missions/:id/finish` avec 5 AFTER mais 0 BEFORE | 409 `MISSION_PHOTOS_INSUFFICIENT { required: { before: 3, after: 5 }, got: { before: 0, after: 5 } }` |
| **V7** | **Payout disabled provider** : `providerPayoutStatus` redevient `PAYOUTS_DISABLED` entre accept et auto-release | Job `escrow.auto-release` bloque (audit `AUTO_RELEASE_BLOCKED { reason: 'payouts_disabled' }`) + alerte admin |
| **V8** | **Expired PaymentIntent** : autorisation Stripe expirée (>7j sans capture) au moment du job auto-release | Détecté côté `paymentIntents.capture()` (Stripe renvoie erreur), audit `CAPTURE_FAILED { reason: 'authorization_expired' }`, mission reste `CLIENT_VALIDATION_PENDING`, alerte admin pour intervention manuelle |
| **V9** | **Spoofed webhook** : POST `/payments/webhooks/stripe` avec body forgé + signature aléatoire | 400 `Invalid signature`, aucune mutation, aucun event persisté |
| **V10** | **Concurrent auto-release** : déclencher manuellement le cron de sécurité `escrow.safety-net` pendant que le job BullMQ delayed s'exécute | 1 seul couple capture+transfer (idempotency-key + lock SQL `WHERE status = 'AUTO_RELEASE_PENDING' AND processedAt IS NULL`) |
| **V11** | **Concurrent refund/capture** : un refund est déclenché (admin) en même temps que le job auto-release tente de capturer | Refund prioritaire ; capture détecte le statut `REFUNDED` et abandonne sans erreur, audit `CAPTURE_SKIPPED { reason: 'refunded' }` |

#### 6.1.3 Méthodologie

- Tous ces tests doivent être implémentés en **tests d'intégration** (pas unit) avec un container Postgres + Redis + Stripe CLI mock + Cloudinary mock.
- Aucun de ces tests ne doit pouvoir être skip via `it.skip` ou `describe.skip`.
- Job CI dédié `verify-prd-003` (similaire à `integration` actuel) qui les exécute.
- Rapport `reviewer-securite-code` final doit citer chaque scénario A-L + V1-V11 avec son test Jest correspondant (path:line).

### 6.2 Smoke test paiement obligatoire (recette + preprod)

- [ ] Carte `4242 4242 4242 4242` → paiement OK end-to-end (PaymentIntent → webhook → mission PAID)
- [ ] Carte `4000 0000 0000 3220` → 3DS challenge (PaymentSheet mobile gère)
- [ ] Carte `4000 0000 0000 9995` → refus (mission reste ACCEPTED, audit PAYMENT_FAILED)
- [ ] Onboarding Stripe Express test → `account.updated` reçu → `stripeTransfersEnabled=true`
- [ ] Auto-release T+48h ouvrées simulé (backdate) → transfer Stripe créé idempotent

### 6.3 Performance gates

- [ ] Webhook handler Stripe < 200ms p95 (juste persist + enqueue, traitement async via BullMQ).
- [ ] POST `/photos/sign` < 100ms p95 (juste signature, pas de lecture Cloudinary).
- [ ] `findEligiblePrestataires` extension `stripeTransfersEnabled` : pas de régression vs PRD-002 (EXPLAIN ANALYZE).

### 6.4 Manual QA recette

- [ ] Happy path complet client : crée mission → publie → prestataire accepte (Stripe ready) → client paie → prestataire start → upload 3 BEFORE → start → upload 5 AFTER → finish → client valide → COMPLETED + transfer Stripe visible.
- [ ] Happy path auto-release : idem mais client ne valide pas → T+48h ouvrées (backdate) → COMPLETED automatique.
- [ ] Sad path : refus paiement, retry, succès.
- [ ] Sad path : prestataire onboarding incomplet → masqué du matching.
- [ ] Sad path : litige client → mission DISPUTE_OPEN, fonds bloqués.

### 6.5 Definition of Done — Verify (release-ready)

- [ ] Rapport `reviewer-securite-code` joint, **0 Critical / 0 Important non traité**
- [ ] **23 audits CTO** : 12 audits techniques (A → L) **+** 11 scénarios D21 (V1 → V11) tous passants
- [ ] Smoke test paiement OK en recette ET en preprod (cartes 4242, 3220, 9995)
- [ ] DLQ + alertes admin fonctionnels (test manuel : webhook 5xx forcé → entrée `WebhookDeadLetter`)
- [ ] Métriques succès instrumentées (events Pino + dashboard admin)
- [ ] Plan de rollback validé : `FF_AUTO_RELEASE_ENABLED=false`, `FF_PAYOUTS_ENABLED=false`, `FF_DISPUTES_ENABLED=false` coupent les chaînes sans migration down
- [ ] Changelog rédigé
- [ ] Sign-off **CTO + référent RGPD**

---

## 7. Post-release

### 7.1 Suivi métriques (J+7, J+30)

À instrumenter avant Verify : taux paiement réussi, taux onboarding, latence webhook, DLQ rate, double capture (doit rester 0).

### 7.2 Incidents éventuels

Post-mortems systématiques sur tout incident finance (perte cash, double payout, double capture). ADR correctifs.

### 7.3 Dette consommée / créée

À documenter en §5.4 pendant Build.

---

## 8. Annexes

### 8.1 Recherches / benchmarks à conduire en Design

- Comparatif **Destination charges** vs **Separate charges and transfers** (Stripe docs) — pour Q1.
- Tarif comparé **SendGrid vs Postmark** sur ~10k mails/mois — pour Q10.
- Test latence Cloudinary signed upload depuis 4G FR (mobile).
- Étude RGPD courte : photo intérieure d'un domicile = "donnée à caractère personnel" classification — confirmer rétention 30j conforme.

### 8.2 Refusés / alternatives (acté sign-off CTO 2026-05-12)

| Alternative | Pourquoi non retenue |
|---|---|
| **Stripe Connect Custom** au lieu d'Express | Custom = on prend la responsabilité KYC/AML + UI = 5x plus complexe. Express = Stripe gère, idéal MVP (cf. D8). |
| **S3 brut** au lieu de Cloudinary | S3 = pas de transformation native (compression, CDN, EXIF strip), DX moins bonne, ré-implémentation de la moitié de Cloudinary (cf. D2). |
| **Capture automatique + `transfer_data.destination`** (Destination charges) | Stripe transfère trop tôt côté compte Connect prestataire. Le CTO veut le contrôle complet du moment du transfer (Q1). Refusé. |
| **Separate charges and transfers** (capture immédiate + transfer séparé) | Capture immédiate = fonds prélevés au client tout de suite, treasury sur compte plateforme. Refusé au profit de **`capture_method='manual'`** (Q1) qui ne prélève qu'à validation, plus juste pour le client. Trade-off accepté : autorisation Visa/MC expire ~7j (mais auto-release T+48h ouvrées tient ≤ 5j calendaires max ponts longs). |
| **Charges directes** (Direct charges) | Marchand de record = prestataire = chacun doit avoir un compte Stripe complet et sa propre page de checkout. Incompatible avec "plateforme absorbe les frais" + casse l'UX unifiée. Refusé (Q6). |
| **Authentification 3DS forcée** | +5 % drop-off conversion observé industrie. Stripe `automatic_payment_methods` optimise risk vs friction (Q8). |
| **Push FCM repoussé en PRD-004** | Le CTO impose **push FCM + email** dès PRD-003 (Q9). Module `notifications` minimal sera intégré au scope Sprint 3. |
| **SMS notifications** | Hors scope MVP (Q9). |
| **Postmark / SendGrid** comme provider email | **Resend** retenu pour DX (React Email native), setup rapide MVP (Q10). Postmark/SendGrid restent éligibles si Resend ne tient pas la charge en prod (révision PRD-004). |
| **Suppression photos par utilisateur** | Catastrophique pour les disputes (preuve disparait). Suppression uniquement via job purge à T+30j (D12). |
| **Base64 uploads** | Mémoire mobile + bande passante + charge serveur. **Multipart direct signed upload uniquement** (D16). |
| **Une seule version Cloudinary par photo** | On garde **2 versions** : original sécurisé pour audit + version compressée display (D17). |
| **LaunchDarkly** ou autre service feature flags MVP | Env vars suffisantes MVP (Q15). Service externe = backlog v2 si besoin de targeting fin. |
| **Moteur TVA MVP** | Hors scope, hypothèse auto-entrepreneurs sous franchise. Stocker `vatRateSnapshot` pour usage futur (Q14). |

### 8.3 Glossaire

- **Escrow** : fonds bloqués sur un compte tiers (ici plateforme Stripe) entre la capture et le transfert vers le bénéficiaire.
- **Stripe Connect Express** : sous-comptes Stripe pour les bénéficiaires, KYC/AML délégués à Stripe, dashboard prestataire hébergé Stripe.
- **PaymentIntent** : objet Stripe représentant l'intention de paiement (montant + currency + customer + idempotency).
- **Transfer** (Stripe) : mouvement de fonds depuis le compte plateforme vers un compte Connect.
- **Payout** : virement vers le compte bancaire du destinataire (Stripe gère, on ne déclenche pas manuellement).
- **Destination charge / Separate charges and transfers / Direct charge** : 3 modèles d'intégration Connect. Cf. ADR-008.
- **Idempotency key** : clé fournie à Stripe pour qu'une mutation soit unique (replay = même résultat, pas de doublon).
- **`mission_events`** : table d'audit héritée de PRD-002, étendue aux events paiement (`PAYMENT_CAPTURED`, `PAYMENT_FAILED`, `TRANSFER_CREATED`, `TRANSFER_FAILED`, `AUTO_RELEASE_TRIGGERED`, `DISPUTE_OPENED`).
- **`stripe_events`** : table de déduplication des webhooks Stripe (clé : `stripe_events.id` UNIQUE).
- **`webhook_dead_letter`** : table des webhooks en échec après 5 retries, retry manuel possible côté admin.
- **DLQ** : Dead Letter Queue — file BullMQ des jobs en échec.
- **`canReleaseEscrow(missionId)`** : invariant central qui vérifie tous les pré-requis avant transfert.

---

## 9. Checklist BMAD globale

- [x] **Discover** : PRD instancié, stories rédigées, risk assessment fait, 15 Open Questions résolues, 21 décisions CTO consolidées — **sign-off CTO 2026-05-12** ✅
- [ ] **Design** : Schémas Prisma + Zod + contrat API + ADRs 008-013 + pré-revue sécu (en cours sur `design/prd-003-photos-paiements`)
- [ ] **Build** : code + tests + migration (bloqué tant que Design non validé CTO)
- [ ] **Verify** : 23 audits CTO (12 base A-L + 11 supplémentaires V1-V11) + smoke paiement + sign-off CTO + référent RGPD (bloqué tant que Build non validé)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-003 v0.2 — Discover validé — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md). Sign-off CTO sur les 15 Open Questions + 6 décisions supplémentaires (D16-D21). Passage Design autorisé.*
