# PRD-003 — Photos AVANT/APRÈS + Stripe Connect Express (Escrow)

> **PRD** = *Product Requirements Document*
> Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) §4.3 & §4.4 (paiements / escrow / commission), §5 (mode offline photos), §6.4 (sécurité photos), §6.5 (RGPD).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).
> Dépendances : [PRD-001 Auth JWT](PRD-001-auth-jwt.md) ✅ `DONE`, [PRD-002 Missions & Géolocalisation](PRD-002-missions-geolocalisation.md) ✅ `RELEASED`.

> **Statut** : 🟡 **DISCOVER_DRAFT** — en attente validation CTO des Open Questions résiduelles avant Design.

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-003` |
| **Slug** | `photos-paiements` |
| **Titre** | Photos AVANT/APRÈS + Stripe Connect Express (escrow) — sous-systèmes Media Evidence / Payment Lifecycle / Mission Completion / Stripe Connect Onboarding |
| **Version PRD** | `0.1` (Discover draft) |
| **Statut** | `DISCOVER_DRAFT` |
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
- ❌ Litiges complexes / arbitrage / remboursement partiel (placeholder seulement, vrai workflow = PRD-006).
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
- [ ] **AC-A.2** — Webhook `account.updated` met à jour `users.stripeAccountId`, `users.stripeChargesEnabled`, `users.stripeTransfersEnabled`, `users.stripePayoutsEnabled`, `users.stripeRequirementsCurrentlyDue` (JSON).
- [ ] **AC-A.3** — Un prestataire dont `transfers !== 'active'` ne peut **pas** apparaître dans le matching (extension du filtre `findEligiblePrestataires` PRD-002 §3) — flag `users.stripeTransfersEnabled` ajouté au WHERE matching.
- [ ] **AC-A.4** — Un prestataire `transfers !== 'active'` qui tente d'`accept` une mission reçoit `403 PRESTATAIRE_PAYMENT_NOT_READY`.
- [ ] **AC-A.5** — Le compte Stripe est créé avec `metadata: { userId, env: NODE_ENV }`, `business_type: 'individual'` (par défaut MVP), `country: 'FR'`.

**Cas d'erreur à couvrir** :
- [ ] Mobile retry POST onboarding-link → renvoie le **même** account si déjà créé (idempotence côté DB sur `users.stripeAccountId`).
- [ ] Webhook `account.updated` reçu hors-ordre (ex: après `account.application.deauthorized`) → on prend toujours le state Stripe le plus récent (refetch via API si doute).

---

### 2.2 Sous-système B — Payment Lifecycle (PaymentIntent + Escrow)

**En tant que** client ayant accepté un devis (mission acceptée par un prestataire)
**Je veux** payer la mission de manière sécurisée
**Pour** réserver le créneau et libérer les fonds quand le travail est validé

- [ ] **AC-B.1** — Le paiement n'est possible **que** sur une mission `ACCEPTED` dont le prestataire a `stripeTransfersEnabled = true`.
- [ ] **AC-B.2** — POST `/payments/missions/:id/intent` (CLIENT owner) crée un PaymentIntent avec **idempotency-key serveur déterministe** = `pi-mission-${missionId}-${attemptNumber}` et retourne `clientSecret`.
- [ ] **AC-B.3** — Mécanique escrow = **separate charges and transfers** (cf. ADR-008 à créer Design — voir §3.3 Q1) : capture immédiate sur compte plateforme, transfer programmé après validation. Pas de `transfer_data.destination` au moment du PaymentIntent.
- [ ] **AC-B.4** — Le `application_fee_amount` (commission 18 % HT) est **calculé serveur**, jamais transmis depuis le client (cf. règle `stripe`).
- [ ] **AC-B.5** — Webhook `payment_intent.succeeded` → mission passe à `PAID`, audit `MissionEvent { type: 'PAYMENT_CAPTURED' }`. Aucune transition basée sur la confirmation **front** (frontend says success ≠ source de vérité).
- [ ] **AC-B.6** — Webhook `payment_intent.payment_failed` → mission reste `ACCEPTED` (NB : pas `PENDING_PAYMENT` — voir Q4 §3.3), audit `PAYMENT_FAILED`. Le client peut ré-essayer (nouvelle attempt → idempotency-key change `attemptNumber`).
- [ ] **AC-B.7** — `PaymentStatus` lifecycle complet en DB : `PENDING → AUTHORIZED → CAPTURED → RELEASE_PENDING → RELEASED → REFUNDED | DISPUTED | FAILED` avec contraintes de transitions strictes (machine d'état dédiée, pattern PRD-002).
- [ ] **AC-B.8** — Tous les events Stripe `payment_intent.*`, `charge.*`, `transfer.*`, `payout.*`, `account.updated`, `charge.dispute.*`, `radar.early_fraud_warning.*` sont écoutés et persistés en `stripe_events` (table dédiée, déduplication via `stripe_events.id` UNIQUE).
- [ ] **AC-B.9** — Aucun PaymentIntent / Transfer / Refund créé sans `idempotencyKey` Stripe (éviter double capture / double payout).
- [ ] **AC-B.10** — Un PaymentIntent ne peut être créé deux fois pour la même mission tant que le précédent est en `PENDING / AUTHORIZED / CAPTURED` (contrainte DB + service).
- [ ] **AC-B.11** — `assertEnvConsistency(event.livemode === isProdEnv)` rejette tout webhook qui mélange test/live (ex: clé `sk_test_*` reçoit un event `livemode=true`).

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
- [ ] **AC-C.2** — **Le binaire ne transite jamais par l'API NestJS** — upload mobile → Cloudinary direct.
- [ ] **AC-C.3** — Idempotence : la même `uuid` (UUID v4 généré côté mobile **avant** capture) renvoyée 2× → 1 seul enregistrement DB (UNIQUE constraint), même `cloudinaryPublicId`.
- [ ] **AC-C.4** — Cloudinary upload preset force : `f_auto, q_auto, type=private, exif=strip` (anti-fuite GPS / device).
- [ ] **AC-C.5** — Metadata DB **obligatoires** : `missionId`, `phase` (`BEFORE | AFTER`), `uploadedBy`, `uploadedAt`, `clientLat`, `clientLng` (envoyées par mobile, séparément de l'EXIF), `clientCheckSumSha256`, `cloudinaryPublicId`.
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
  - 3 jobs delayed `notif.reminder` à T+24h, T+36h, T+47h ouvrées.
- [ ] **AC-D.5** — POST `/missions/:id/validate` (CLIENT owner) → `CLIENT_VALIDATION_PENDING → COMPLETED` immédiat, déclenche `payments.transferToProvider()` (Stripe Transfer API avec idempotencyKey = `transfer-mission-${missionId}`), annule le job `escrow.auto-release`.
- [ ] **AC-D.6** — Job `escrow.auto-release` : revalide les invariants (`canReleaseEscrow`) → si OK : transfer, `COMPLETED`. Sinon : audit `AUTO_RELEASE_BLOCKED` + alerte admin (ne change pas le state).
- [ ] **AC-D.7** — Cron horaire de **sécurité** `escrow.safety-net` : scanne les missions en `CLIENT_VALIDATION_PENDING` qui ont dépassé `now + 48h ouvrées + 1h marge` et n'ont pas été libérées (delayed job perdu) → tentative + alerte si échec.
- [ ] **AC-D.8** — `canReleaseEscrow(missionId)` vérifie : (a) mission status ∈ `{ CLIENT_VALIDATION_PENDING, COMPLETED }`, (b) ≥ 3 photos BEFORE syncées, (c) ≥ 5 photos AFTER syncées, (d) pas de litige `DISPUTE_OPEN`, (e) `paymentStatus = CAPTURED`, (f) prestataire `stripeTransfersEnabled = true`.
- [ ] **AC-D.9** — POST `/missions/:id/dispute` (CLIENT owner, fenêtre = T+48h ouvrées max après `CLIENT_VALIDATION_PENDING`) → `DISPUTE_OPEN`, annulation job `escrow.auto-release`, audit `DISPUTE_OPENED { reason }`. Process litige détaillé = PRD-006.

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
- [x] `apps/api/src/modules/missions/` — **EXTENSION** : nouveaux états `PAID / IN_PROGRESS / CLIENT_VALIDATION_PENDING / COMPLETED / DISPUTE_OPEN / REFUNDED`, hooks photo count, hook `stripeTransfersEnabled` dans `findEligiblePrestataires`.
- [x] `apps/api/src/modules/notifications/` — **NOUVEAU** (ou extension future PRD-005) : rappels push T+24h/T+36h/T+47h. **Décision MVP** : juste log + email (FCM repoussé PRD-005, voir Q9 §3.3).
- [x] `apps/api/src/modules/disputes/` — **PLACEHOLDER** : route POST `/missions/:id/dispute` qui passe en `DISPUTE_OPEN`. Vrai workflow = PRD-006.
- [x] `apps/api/src/queue/processors/` — **NOUVEAU** : `escrow-auto-release.processor.ts`, `stripe-webhook.processor.ts`, `cloudinary-webhook.processor.ts`, `photos-purge.processor.ts`.
- [x] `apps/mobile/src/features/payments/` — **NOUVEAU** : intégration `@stripe/stripe-react-native` (PaymentSheet), écrans onboarding Connect, écrans validation client.
- [x] `apps/mobile/src/features/photos/` — **NOUVEAU** : capture (expo-camera), compression (expo-image-manipulator 1600px qualité 75), file MMKV, sync background (expo-task-manager + expo-background-fetch).
- [x] `apps/admin/src/pages/payments/` — **NOUVEAU** : dashboard paiements + webhook DLQ + retry manuel.
- [x] `packages/shared-types/src/zod/` — **EXTENSION** : `payment.ts`, `photo.ts`, états mission étendus.
- [x] `apps/api/prisma/schema.prisma` — **EXTENSION** : `Payment`, `StripeEvent`, `Photo`, `WebhookDeadLetter`, extension `User` (champs Stripe), extension `Mission` (états + relations).
- [x] Configuration / infra / CI : nouveaux env vars Stripe + Cloudinary, secrets manager, webhook endpoint exposé HTTPS (ngrok/cloudflare en dev, vrai domaine en preprod/prod).

### 3.3 Open questions (à résoudre AVANT Design)

> Décisions CTO **déjà tranchées** (issues du message d'ouverture) — sont consignées en §3.4 ci-dessous.
> Ce tableau ne liste que les questions **résiduelles** qui doivent être tranchées par le CTO avant validation Discover.

| # | Question | Owner | Statut | Réponse |
|---|---|---|---|---|
| **Q1** | **Mécanique escrow exacte** — le CTO a écrit "manual capture + delayed transfer", mais ce sont 2 mécaniques **distinctes** : (a) `capture_method='manual'` (autorisation puis capture, **mais l'autorisation expire à 7j sur Visa/MC** → si auto-release T+48h ouvrées tombe au-delà, échec capture) ; (b) `capture_method='automatic'` + Transfer API séparé (**capture immédiate côté plateforme + transfer programmé**, c'est ce que stripe.mdc & cahier v1.4 §4.3 décrivent déjà comme "separate charges and transfers"). **Reco senior-dev : (b) — pas d'expiration, treasury sur compte plateforme contrôlé, conforme à la rule existante**. À confirmer CTO. | CTO | `OPEN` | _en attente_ |
| **Q2** | **Réconciliation rétention photos** : règle `.cursor/rules/photos-rgpd.mdc` dit **12 mois**, décision CTO PRD-003 dit **30 jours** post-completion. La nouvelle décision est plus courte donc plus protectrice RGPD ✅, mais il faut acter via un **ADR** + mettre à jour la règle Cursor. **Question** : la rétention `30j` s'applique-t-elle à la `mission.completedAt` ou à `mission.disputeResolvedAt` (si litige) ? Et **qui** déclenche le purge job (cron quotidien recommandé) ? | CTO | `OPEN` | _en attente_ |
| **Q3** | **Géolocalisation des photos** — le CTO demande `lat/lng` dans la metadata photo. EXIF GPS Cloudinary doit être stripé (`exif=strip`) pour éviter fuite via signed URL. **Reco** : (a) strip EXIF Cloudinary, (b) le mobile envoie **séparément** `clientLat / clientLng / accuracy` dans le body POST `/photos/sign` (sources : `expo-location` au moment de la capture), (c) backend stocke en DB (jamais réinjecté dans Cloudinary). **Question** : si l'utilisateur refuse la permission GPS, on autorise quand même l'upload (et `clientLat/lng` = null) ou on bloque ? Reco MVP : autoriser, logger un warning. | CTO | `OPEN` | _en attente_ |
| **Q4** | **Workflow paiement vs acceptation** — où s'insère `PAID` dans la machine d'état ? Variante A : **pré-paiement** (CLIENT paie avant publication, fonds bloqués dès création — friction client mais pas de no-show). Variante B : **post-acceptation** (`ACCEPTED → PENDING_PAYMENT → PAID`, le client paie une fois qu'un prestataire l'a accepté — moins de friction client mais risque de no-show paiement). **Reco senior-dev : variante B** (UX standard Uber/Doctolib + cohérent avec lock optimiste prestataire PRD-002). À confirmer CTO. | CTO | `OPEN` | _en attente_ |
| **Q5** | **Bouton "Valider et débloquer"** — message CTO : *"Validation manuelle par le prestataire (bouton « Valider et débloquer ») ou auto-déblocage après T+48h"*. Mais c'est étrange : c'est le **prestataire** qui demanderait son propre déblocage de fonds ? Le workflow proposé en §7 du message CTO dit `AFTER_UPLOADED → CLIENT_VALIDATION_PENDING → AUTO_RELEASE_PENDING → COMPLETED`, ce qui implique que c'est le **client** qui valide (ou silence ⇒ auto-release). **Reco** : c'est bien le **CLIENT** qui valide (cf. cahier v1.4 §4.3). Demande de confirmation explicite CTO. | CTO | `OPEN` | _en attente_ |
| **Q6** | **Marchand de record sur le reçu Stripe** — avec "plateforme absorbe les frais" + Stripe Connect + commission 18 %, on est en pratique en **Destination charges** ou **Separate charges and transfers**. Dans les deux cas, le **marchand de record est Clean Connect**, le reçu mentionne Clean Connect (pas le prestataire). Le prestataire n'est qu'un **bénéficiaire de transfert**. C'est l'architecture la plus simple MVP. **Question** : le prestataire doit-il pouvoir voir son propre reçu / dashboard Stripe Express (Stripe propose un dashboard prestataire natif) ou on gère tout côté admin Clean Connect MVP ? Reco : activer le dashboard Stripe Express prestataire (gratuit, Stripe-hébergé, conforme). | CTO | `OPEN` | _en attente_ |
| **Q7** | **Onboarding strict vs souple** — un prestataire dont `transfers !== 'active'` doit-il : (a) être exclu du matching (le client ne le voit pas, pas de no-show paiement), ou (b) apparaître mais bloqué à l'`accept` ? **Reco senior-dev : (a) — strict**. Cohérent avec exclusions PRD-002 §5. À confirmer CTO. | CTO | `OPEN` | _en attente_ |
| **Q8** | **Paiement carte non-3DS** — Stripe Radar peut rejeter, ou demander 3DS dynamique. Faut-il **forcer 3DS** sur tous les paiements MVP (réduit fraude mais friction +5 % drop-off conversion observé industrie) ou laisser Stripe choisir (`request_three_d_secure='automatic'`) ? Reco MVP : **automatique** (Stripe optimise le risk vs friction). À confirmer. | CTO | `OPEN` | _en attente_ |
| **Q9** | **Notifications rappel auto-release** (T+24h/36h/47h) — FCM push **ou** email **ou** les deux ? FCM nécessite le module notifications complet (PRD-005 prévu après). **Reco MVP** : email seulement (SendGrid/Postmark) + 1 banner persistant in-app sur l'écran mission. Push FCM = PRD-005. À confirmer CTO. | CTO | `OPEN` | _en attente_ |
| **Q10** | **Provider email transactionnel** — SendGrid ou Postmark (cf. CLAUDE.md mentions les deux) ? **Reco senior-dev : Postmark** (DX meilleure, IP dédiées par défaut, parsing inbound facile pour les disputes futures, prix raisonnable < 500k mails/mois). À confirmer CTO. | CTO | `OPEN` | _en attente_ |
| **Q11** | **Currency MVP** — confirmé EUR seulement ? Tous les `Mission.estimatedPriceCents` sont déjà en euros (PRD-002). Devises multiples = backlog v2. | CTO | `OPEN` | _en attente_ |
| **Q12** | **Stripe API version pinnée** — doit-on pin une version Stripe (`apiVersion: '2025-06-30.basil'` ou similaire) au boot pour garantir reproductibilité ? **Reco** : oui, pin une version explicite + ADR pour tracer les bumps. | CTO | `OPEN` | _en attente_ |
| **Q13** | **Géofencing soft des photos** — si la lat/lng de la photo AFTER est à > 500m de l'adresse mission, on log un warning ou on bloque ? **Reco MVP** : log + flag `photo.geoOutlier=true` pour audit, **pas de blocage** (le prestataire peut prendre une photo dans un local technique ou en sortant). À confirmer. | CTO | `OPEN` | _en attente_ |
| **Q14** | **Tax / TVA** — Clean Connect facture **TTC** au client, transfère **HT moins commission** au prestataire ? Ou bien le prestataire reçoit son net après commission, et la TVA reste un sujet entre lui et l'État (auto-entrepreneur sous franchise) ? **Question** : le `application_fee_amount` est calculé sur le HT ou TTC ? **Reco** : MVP = on assume que tous les prestataires sont auto-entrepreneurs sous franchise TVA, donc on facture TTC = HT, commission 18 % du TTC. À confirmer (sera affiné PRD-006 disputes / facturation). | CTO + référent compta | `OPEN` | _en attente_ |
| **Q15** | **Soft-launch / feature flag** — on déploie PRD-003 derrière un `FF_PAYMENTS_ENABLED` (env var simple, pas de service feature flags MVP) qui permet de couper toute la chaîne paiement si problème détecté en prod ? Reco : oui, flag simple. | CTO | `OPEN` | _en attente_ |

> ⛔ **Règle dure** : aucune Open Question résiduelle ne peut rester `OPEN` à l'entrée en Design.

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
| D15 | Mission completion workflow | ✅ États : `DRAFT / PUBLISHED / ACCEPTED / PENDING_PAYMENT / PAID / IN_PROGRESS / CLIENT_VALIDATION_PENDING / COMPLETED / DISPUTE_OPEN / REFUNDED / CANCELLED / EXPIRED` (extension PRD-002). Voir §3.5 schéma. |

### 3.5 Machine d'état mission étendue (proposition Discover)

> Extension du `mission-state.machine.ts` PRD-002. Le détail typing + assertions sera figé en Design.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                                                         │
                  ▼                                                         │
    DRAFT ──publish──→ PUBLISHED ──accept──→ ACCEPTED ──pay-intent--→  PENDING_PAYMENT
      │                  │ │                    │                              │
      │                  │ │                    │                              ▼
      │                  │ │                    │                  payment_intent.succeeded
      │                  │ │                    │                              │
      │                  │ │                    │                              ▼
      └─────────────cancel/expire───────────────┘                            PAID
                                                                              │
                                                                  start (3+ photos BEFORE)
                                                                              │
                                                                              ▼
                                                                       IN_PROGRESS
                                                                              │
                                                                  finish (5+ photos AFTER)
                                                                              │
                                                                              ▼
                                                              CLIENT_VALIDATION_PENDING
                                                                  │           │
                                                          validate            (silence T+48h ouvrées)
                                                          (CLIENT)            │
                                                                  │           ▼
                                                                  │   AUTO_RELEASE_PENDING
                                                                  │           │
                                                                  │  escrow.auto-release job
                                                                  │           │
                                                                  ▼           ▼
                                                                  COMPLETED ◀┘
                                                                  │
                                                                  └──── (rare) ── REFUNDED

                  À tout moment depuis CLIENT_VALIDATION_PENDING (T+48h max) :
                  ──── dispute (CLIENT) ────→ DISPUTE_OPEN (process PRD-006)
```

**Règles dures associées** :
- Aucune transition non listée n'est autorisée (continue PRD-002 `assertMissionTransition` étendu).
- Tout passage par `payments.transferToProvider()` est **idempotent** (key = `transfer-mission-${missionId}`).
- Tout passage en `COMPLETED` doit avoir `paymentStatus = RELEASED` ET `≥ 5 photos AFTER syncées` ET `≥ 3 photos BEFORE syncées` ET pas de `DISPUTE_OPEN`.

### 3.6 Definition of Done — Discover

- [x] PRD instancié avec ID, slug, statut `DISCOVER_DRAFT`
- [x] Lien explicite vers cahier v1.4 §4.3, §4.4, §5, §6.4, §6.5
- [x] User stories couvrant **les 4 sous-systèmes** (A Onboarding Connect / B Payment Lifecycle / C Photos / D Completion Workflow) avec critères d'acceptance testables
- [x] Risk assessment renseigné (3 domaines ≥ 4 ⇒ pré-revue sécu Design + Verify renforcée)
- [x] Métriques de succès quantifiables
- [x] Out of scope explicite (10+ items)
- [x] Décisions CTO déjà tranchées consolidées (15 items)
- [x] Machine d'état mission étendue proposée (à figer Design via ADR)
- [x] T-shirt size estimé (XL)
- [ ] Open questions résiduelles toutes résolues (`RESOLVED`) — **15 questions OPEN, en attente CTO**
- [ ] **Validation humaine** (Owner produit) : nom + date

> ⏳ Validé Discover par `<CTO>` le `YYYY-MM-DD`.

---

## 4. Phase DESIGN

⛔ Bloquée tant que les 15 Open Questions §3.3 ne sont pas `RESOLVED` + sign-off CTO Discover.

**Livrables prévus** :
1. **Schéma Prisma** complet pour `Payment`, `StripeEvent`, `WebhookDeadLetter`, `Photo`, extension `User` (`stripeAccountId`, `stripeChargesEnabled`, `stripeTransfersEnabled`, `stripePayoutsEnabled`, `stripeRequirementsCurrentlyDue`), extension `Mission` (nouveaux états).
2. **Schémas Zod** dans `packages/shared-types/src/zod/`.
3. **Contrat API** complet (chaque route, rate limit, idempotence, codes HTTP).
4. **State machine paiement** + extension state machine mission, avec assertions strictes.
5. **ADRs prévus** :
   - ADR-008 — Mécanique escrow Stripe (separate charges & transfers vs destination vs manual capture). **À écrire après réponse Q1**.
   - ADR-009 — Cloudinary signed upload + EXIF strip + lat/lng séparé.
   - ADR-010 — Politique rétention photos 30j (remplace mention 12 mois `photos-rgpd.mdc`).
   - ADR-011 — Email transactionnel provider (SendGrid vs Postmark). **À écrire après réponse Q10**.
6. **Mise à jour règles Cursor** : `.cursor/rules/photos-rgpd.mdc` (rétention 30j), `.cursor/rules/stripe.mdc` (mécanique exact escrow finale).
7. **Plan de tests** détaillé (unit / intégration / E2E mobile / sécu / perf / smoke paiement).
8. **Rollout** : feature flag `FF_PAYMENTS_ENABLED` + plan de rollback (revert webhooks, désactivation flag, mais migrations gardées additivement).
9. **Pré-revue `reviewer-securite-code` OBLIGATOIRE** (risque ≥ 4 sur sécu/finance/RGPD).

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

| # | Audit | Risque cible |
|---|---|---|
| **A** | Idempotence webhook Stripe (replay 10× même `stripe_events.id`) | Pas de double mutation, pas de double transfer |
| **B** | Idempotence Stripe API mutations (capture, transfer, refund) — replay même `idempotencyKey` | Stripe garantit pas de duplication |
| **C** | Race validate vs auto-release (CLIENT POST `/validate` simultané au job BullMQ) | Un seul transfer Stripe créé |
| **D** | Webhook Stripe signature invalide (forge HMAC) → rejet 400 | Aucun event traité |
| **E** | Cohérence env (event `livemode=true` reçu sur DB test) → rejet | Pas de pollution croisée |
| **F** | Photos count validation (4 BEFORE, 5 AFTER → 409 INSUFFICIENT) | Pas de bypass |
| **G** | Suppression photo manuelle pré-rétention → 403 | Pas de purge prématurée |
| **H** | Signed URL Cloudinary expire bien à 5min | Pas d'URL longue |
| **I** | Webhook Cloudinary signature invalide → rejet | Pas de mutation depuis source non vérifiée |
| **J** | DLQ webhook (échec 5 retries) → alerte admin + entry en `webhook_dead_letter` | Pas de perte silencieuse |
| **K** | Pino redactor étendu vérifie absence de `cardNumber`, `cvv`, `stripeAccountId`, `bankAccount.*` dans tous les logs | Pas de PII finance |
| **L** | RGPD : DELETE `/users/me` purge bien les photos uploadées (sauf litige actif) à T+30j | Droit à l'effacement respecté |

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
- [ ] **12 audits CTO** (A → L) tous passants
- [ ] Smoke test paiement OK en recette ET en preprod
- [ ] DLQ + alertes admin fonctionnels (test manuel : webhook 5xx forcé → entrée DLQ)
- [ ] Métriques succès instrumentées (events Pino + dashboard admin)
- [ ] Plan de rollback validé (FF_PAYMENTS_ENABLED=false coupe la chaîne sans migration down)
- [ ] Changelog rédigé
- [ ] Sign-off CTO + référent RGPD

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

### 8.2 Refusés / alternatives (à arbitrer Design)

| Alternative | Pourquoi probablement non retenue |
|---|---|
| **Stripe Connect Custom** au lieu d'Express | Custom = on prend la responsabilité KYC/AML + UI = 5x plus complexe. Express = Stripe gère, idéal MVP (cf. décision CTO D8). |
| **S3 brut** au lieu de Cloudinary | S3 = pas de transformation native (compression, CDN, EXIF strip), DX moins bonne, ré-implémentation de la moitié de Cloudinary (cf. décision CTO D2). |
| **Capture immédiate avec `transfer_data.destination`** (Destination charges) | Capture sur compte plateforme + transfer auto Stripe = correspond moins au pattern "escrow puis libération conditionnelle" car Stripe transfère immédiatement. **Separate charges and transfers** offre plus de contrôle. |
| **Charges directes** (Direct charges) | Marchand de record = prestataire = chacun doit avoir un compte Stripe complet et sa propre page de checkout. Incompatible avec "plateforme absorbe les frais" + casse l'UX unifiée. |
| **Authentification 3DS forcée** | +5 % drop-off conversion observé industrie. Stripe `automatic` optimise risk vs friction (cf. Q8). |
| **Push FCM rappels MVP** | Module notifications pas encore livré, scope creep. Email + banner in-app suffisent MVP (cf. Q9). |
| **Suppression photos par utilisateur** | Catastrophique pour les disputes (preuve disparait). Suppression uniquement via job purge à T+30j. |

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

- [x] **Discover** : PRD instancié, stories rédigées, risk assessment fait — **en attente Open Questions résolues + sign-off CTO**
- [ ] **Design** : Schémas Prisma + Zod + contrat API + ADRs + pré-revue sécu (bloqué tant que Discover non validé)
- [ ] **Build** : code + tests + migration (bloqué tant que Design non validé)
- [ ] **Verify** : 12 audits CTO + smoke paiement + sign-off CTO + référent RGPD (bloqué tant que Build non validé)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-003 v0.1 — Discover draft — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md). Réponse aux 15 Open Questions §3.3 attendue avant validation Discover.*
