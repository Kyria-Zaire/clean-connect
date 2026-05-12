# Changelog

Toutes les modifications notables apportées à Clean Connect sont consignées dans ce fichier.

Le format est inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

Chaque entrée référence le PRD pilote (cf. [`docs/prd/README.md`](docs/prd/README.md))
et le rapport sécurité associé (`docs/security-reviews/`).

---

## [Unreleased]

### Release Candidate — PRD-003 Photos & Paiements (Sprint 3) — 2026-05-12

✅ **Sign-off CTO accordé sur les 3 PRs Verify (PR #11 Build, PR #12 Verify intermédiaire, PR #13 Verify final).**
Périmètre **feature-complete + audit-complete + release-candidate**. Tag prévu : `v3.0.0-prd003` après exécution humaine des smoke §6.2, perf §6.3 et sign-off RGPD (cf. [`docs/release/v3.0.0-prd003.md`](docs/release/v3.0.0-prd003.md)).
Rapport sécurité final : [`docs/verify/PRD-003-audit-securite-ticket-3-6.md`](docs/verify/PRD-003-audit-securite-ticket-3-6.md) — **0 Critical / 0 Important**, grille §6.1 entièrement couverte.

#### Added — Paiements (Stripe Connect Express + escrow)

- **`POST /api/v1/payments/intent`** (CLIENT) — création PaymentIntent en `capture_method='manual'`, header `Idempotency-Key` obligatoire, idempotence forte côté serveur (mode `loose`).
- **`GET /api/v1/payments/mine`** (CLIENT) — listing paginé ; `clientSecret` jamais exposé hors `POST /intent`.
- **`POST /api/v1/webhooks/stripe`** (`@Public()` + `@SkipThrottle()`) — pipeline `signature HMAC → livemode → payloadHash → INSERT idempotent → enqueue BullMQ`. Body raw obligatoire (`main.ts: rawBody=true`).
- **`POST /api/v1/admin/payments/:paymentId/refund`** (ADMIN) — refund **intégral uniquement** (MVP). `422 PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED`, `409 PAYMENT_REFUND_BLOCKED_TRANSFER_SENT`, `409 PAYMENT_ALREADY_REFUNDED`. Idempotence via unique `(payment_id)` Refund.
- **`GET /api/v1/admin/payments`** + **`GET /api/v1/admin/transfers`** + **`POST /api/v1/admin/transfers/:id/retry`** + **`GET /api/v1/admin/webhooks/stripe-dead-letters`** + **`POST /api/v1/admin/webhooks/stripe-dead-letters/:id/replay`** — console admin (ADMIN only).
- **Outbound transfer Connect** (`OutboundTransferService`) — déclenché après webhook `payment_intent.succeeded` (`PaymentDomainHandler.onCaptured`). Idempotence : unique `Transfer.paymentId` + `idempotencyKey` Stripe `transfer-mission-<id>`. Refuse si `providerPayoutStatus !== READY` (`payouts/transfers/charges disabled`).
- **Webhooks `transfer.created` / `updated` / `reversed`** (`TransferDomainHandler`) — `transfer.reversed` → Mission `COMPLETED → DISPUTE_OPEN`.
- **Webhooks `charge.refunded` / `charge.refund.updated`** (`RefundDomainHandler`) — Payment `REFUND_PENDING → REFUNDED` ou retour `CAPTURED` si `FAILED`.
- **Reconcile cron** (`TransferReconcileScheduler`) — détecte `Transfer.PENDING > 2h` et appelle `stripe.transfers.retrieve` pour resync (`@Cron`).

#### Added — Mission completion + auto-release T+48 h ouvrées

- **`POST /api/v1/missions/:id/complete`** (PRESTATAIRE) — `ACCEPTED → CLIENT_VALIDATION_PENDING`. Prérequis : ≥ 3 photos BEFORE + ≥ 5 photos AFTER syncées (`MissionPhotoQuotaService`). Crée `AutoReleaseJob` SCHEDULED + delayed job BullMQ idempotent (`buildAutoReleaseBullJobId`).
- **`POST /api/v1/missions/:id/validate`** (CLIENT) — annule auto-release + appelle `PaymentsService.requestCapture` (idempotency-key `capture-mission-<id>`).
- **`POST /api/v1/missions/:id/report-problem`** (CLIENT) — `CLIENT_VALIDATION_PENDING → DISPUTE_OPEN` + annule auto-release.
- **`AutoReleaseProcessor` / `AutoReleaseExecutor`** — verrou applicatif `lockedAt`/`lockedBy` (audit V10), idempotence Stripe via clé déterministe.

#### Added — Photos & Cloudinary signed upload

- **`POST /api/v1/missions/:id/photos/presign`** (PRESTATAIRE | ADMIN) — `PhotoUploadSession` (TTL 5 min, tokenDigest SHA-256) + signed URL Cloudinary HMAC-SHA-1.
- **`POST /api/v1/missions/:id/photos/confirm`** (PRESTATAIRE | ADMIN) — vérifie session (anti cross-mission, anti session-stealing) + appel `cloudinary.api.resource` + insertion `Photo` idempotente (`UNIQUE (mission_id, capture_client_uuid, variant)`).
- **Variant `DISPLAY`** exposé publiquement ; **`ORIGINAL`** réservé ADMIN (audit / antifraude).

#### Added — Schéma DB (9 migrations Prisma)

`prisma/migrations/` — toutes additives sauf renommages explicites :

1. `20260512143000_prd003_payment_models` — `Payment`, `Transfer`, `Refund`, `StripeWebhookEvent`, `WebhookDeadLetter`.
2. `20260512170000_prd003_photo_upload_session` — `PhotoUploadSession`.
3. `20260512183000_prd003_photo_variant_capture_uuid` — `Photo.variant`, `Photo.captureClientUuid`, contrainte unique.
4. `20260512190000_prd003_mission_status_paid_payment_lifecycle` — états mission `PENDING_PAYMENT`, `IN_PROGRESS`, `CLIENT_VALIDATION_PENDING`, `COMPLETED`, `DISPUTE_OPEN`, `REFUNDED`.
5. `20260512195000_prd003_auto_release_jobs` — `AutoReleaseJob`.
6. `20260512204500_prd003_provider_payout_status` — capabilities Stripe Connect sur `User`.
7. `20260512210000_prd003_transfer_refund_lifecycle_fields` — colonnes `failureCode/Reason`, `idempotencyKey`, `stripeRefundId`.
8. `20260512212000_prd003_mission_event_types_payments` — enum élargi `PAYMENT_CAPTURED`, `MISSION_COMPLETED`, `AUTO_RELEASE_*`, `PAYMENT_REFUNDED`, `TRANSFER_*`.
9. `20260512214500_prd003_photo_deletion_log` — `PhotoDeletionLog` (audit RGPD purge).

#### Added — Tests (Sprint 3)

- **Unit (`pnpm --filter @cc/api test`)** — **19 suites / 214 tests** verts.
- **Intégration (`pnpm --filter @cc/api run test:integration`)** — **12 suites / 105 tests** verts :
  - `payments-webhook.integration.spec.ts` — signature HMAC, livemode, replay idempotent, FF_PAYMENTS_ENABLED.
  - `payments-intent.integration.spec.ts` — idempotency-key, ownership, clientSecret non listé.
  - `payments-domain.integration.spec.ts` — lifecycle PaymentIntent (succeeded / failed / canceled / authorization_expired) + auto-release cancel.
  - `payments-ticket-3-5.integration.spec.ts` — Transfer outbound (metadata no PII, no double payout, transfer.reversed → DISPUTE_OPEN), refunds admin-only / intégral / no double / blocked after Transfer SENT, DLQ replay, reconcile cron.
  - `photos.integration.spec.ts` — presign / confirm / cross-mission / expiration / asset missing.
  - **`payments-verify-3-6.integration.spec.ts`** (Ticket 3.6) — replay handler ×5 idempotent, V7 PAYOUTS_DISABLED, V11 refund vs replay.
  - **`payments-verify-3-6-bis-concurrency.integration.spec.ts`** (Ticket 3.6-bis) — **V2/C** double validate, **V3** double schedule + double enqueue, **V10** auto-release vs CAPTURED, **V11** auto-release vs REFUND_PENDING.
  - **`photos-verify-3-6-bis-quotas-rbac.integration.spec.ts`** (Ticket 3.6-bis) — **V4** sans JWT → 401, **H** signed URL TTL ≤ 300 s, **V6** AFTER sans BEFORE, **F** quotas exacts.
- **Couverture grille §6.1** : 9/12 audits techniques testés intégration + 3 reclassés dette PRD-004 (G/I/L — endpoints hors-scope) ; **11/11** scénarios V1–V11 couverts.

#### Added — Sécurité (audit Verify)

- **Pino redactor** étendu (`app.module.ts:37-87`) : `stripe-signature`, `idempotency-key`, `clientSecret`, `stripeAccountId`, `bankAccount`, `card.number`, `cvv`, `payment_method`, `cloudinaryParams.signature`, `api_secret`, `sessionToken`, `tokenDigest`, `captureClientUuid`, `gpsLat/Lng`, `email`, `street`, `password*`, `*Token`.
- **RBAC** : tous les controllers métier (`payments`, `admin-*`, `missions`, `mission-completion`, `photos`) sous `JwtAccessGuard` + `RolesGuard` + `@Roles(...)`. Seul `POST /webhooks/stripe` est `@Public()` (auth HMAC).
- **Idempotence** : webhook (`stripe_event_id` unique), Stripe API (idempotency-key déterministe `capture-mission-<id>`, `transfer-mission-<id>`, `refund-<paymentId>`), Photo (UUID client + UNIQUE `(mission_id, capture_client_uuid, variant)`).
- **Isolement env** : `assertEnvConsistency` rejette `event.livemode=true` en recette/preprod (400 `WEBHOOK_LIVEMODE_MISMATCH`).

#### Added — Documentation

- **PRD** : [`docs/prd/PRD-003-photos-paiements.md`](docs/prd/PRD-003-photos-paiements.md) v1.0 — §6.5 lié rapport ; §7.3 dette à jour avec arbitrage CTO (G/I/L → PRD-004).
- **OpenAPI** : [`docs/api/PRD-003-openapi.yaml`](docs/api/PRD-003-openapi.yaml) v`1.0.8-prd003-ticket-3.6-verify-openapi-align`.
- **ADRs** : ADR-008 (séparation Payment / Transfer / Refund), ADR-009 (`PHOTO_MIN_BEFORE/AFTER`), ADR-010 (rétention 30 j photos), ADR-011 (verrou applicatif `auto_release_jobs`).
- **Rapport sécu** : [`docs/verify/PRD-003-audit-securite-ticket-3-6.md`](docs/verify/PRD-003-audit-securite-ticket-3-6.md) — 0 Critical / 0 Important, grille §6.1 complète, smoke §6.2 + perf §6.3 + RGPD sign-off form + release checklist.
- **Release runbook** : [`docs/release/v3.0.0-prd003.md`](docs/release/v3.0.0-prd003.md) — procédure tag + déploiement + rollback.

#### Configuration

- `FF_PAYMENTS_ENABLED` (booléen) — gate paiements + webhook Stripe ; 503 `PAYMENTS_DISABLED` si off.
- `FF_PHOTOS_ENABLED` (booléen) — gate presign/confirm ; 503 `PHOTOS_DISABLED` si off.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`.
- `CLOUDINARY_URL`, `CLOUDINARY_FOLDER_PREFIX`, `PHOTO_UPLOAD_SESSION_TTL_SECONDS=300`, `PHOTO_SIGNED_URL_TTL_SECONDS=300`.
- `AUTO_RELEASE_BUSINESS_HOURS=48` (heures ouvrées Europe/Paris).

#### Dette créée (arbitrage CTO — reportée PRD-004)

| Slug | Audit § | Statut |
|---|---|---|
| `debt-prd004-transfer-retry-queue` | — | Retry transfer admin manuel (`POST /admin/transfers/:id/retry`) ; auto BullMQ reporté. |
| `debt-prd004-orphan-cleanup` | — | `PhotoUploadSession` orphelins (TTL 5 min, volume borné). |
| `debt-prd004-photo-delete-endpoint` | §6.1 G | `DELETE /photos/:id` manuel ; purge actuelle = cron rétention 30 j. |
| `debt-prd004-cloudinary-webhook-in` | §6.1 I | Webhook entrant Cloudinary ; Cloudinary aujourd'hui = sortant uniquement (validé via `getResource`). |
| `debt-prd004-rgpd-self-delete` | §6.1 L | `DELETE /users/me` self-service ; voie actuelle = demande email + action admin. |
| `debt-coderabbit-typing` | — | Exceptions typées, repository pattern strict, logs refund symétriques (DX). |

#### Stats finales Sprint 3

- **6 tickets** : 3.1 (webhook ingestion), 3.2 (PaymentIntent), 3.3 (Cloudinary signed upload), 3.4 (mission completion + capture), 3.5 (transfers + refunds + DLQ + reconcile), 3.6 + 3.6-bis (Verify).
- **6 PRs mergées** : #7, #8, #9, #10, #11, #12, #13.
- **9 migrations Prisma** appliquées sur recette ; à appliquer en preprod puis prod.
- **214 unit tests + 105 integration tests** verts en local et CI.
- **CI** : Quality / Integration / Docker Build — vertes sur la branche `main` à `cb6c9a3`.

---

### Verify — PRD-002 Missions & Géolocalisation (Ticket 2.3) — 2026-05-12

✅ **Sign-off CTO accordé — merge PR #4 autorisé.**
Rapport sécurité complet : [`docs/security-reviews/2026-05-12-prd-002-missions-build-verify.md`](docs/security-reviews/2026-05-12-prd-002-missions-build-verify.md).

#### Added — Tests Verify (21 nouveaux cas intégration + 16 unit)

- **`apps/api/test/integration/missions-verify.integration.spec.ts`** — couvre les **5 audits CTO obligatoires** :
  - **A** : idempotence accept (double POST même provider) — pas de double event ni de mutation, `updated_at` inchangé sur 2ᵉ POST.
  - **B** : race cancel vs accept — état final cohérent + erreur précise (`mission_cancelled`).
  - **C** : ADMIN voit `address.kind=FULL` ; logs Pino restent redacted (preuve runtime).
  - **D** : `MissionEvent` payload hygiene — refuse adresse complète + email + phone + token + jwt + password + authorization (8 cas négatifs + 1 cas positif).
  - **E** : race expiration vs accept — UPDATE conditionnels Postgres mutuellement exclusifs.
  - **+** RBAC complémentaire : `GET /missions/:id` sans token → 401, `POST /accept` sans token → 401, `GET /admin/missions` avec rôle CLIENT → 403.
- **`mission-event.types.spec.ts`** étendu : 16 nouveaux cas pour la nouvelle fonction `assertEventPayloadHygiene`.

#### Changed — Durcissements Verify (sans nouvelle feature)

- **`MissionsService.accept()`** post-race : distingue maintenant précisément `ACCEPTED → MISSION_ALREADY_ACCEPTED`, `CANCELLED → mission_cancelled`, `EXPIRED → mission_expired`, `PUBLISHED → MISSION_NOT_ELIGIBLE`. Plus aucun message d'erreur trompeur.
- **`toInvalidStateError()`** produit un `reason` sémantique stable (`mission_cancelled` / `mission_expired` / `mission_already_accepted`) au lieu de la forme brute `CANCELLED->ACCEPTED`. Permet un mapping i18n stable côté front/mobile.
- **`assertNoAddressLeak`** renommée en **`assertEventPayloadHygiene`** (alias rétrocompat) avec périmètre élargi : refuse désormais clés `email*`, `phone*`, `mobile`, `telephone`, `password*`, `token*`, `jwt`, `authorization`, `apiKey`, `secret*` en plus des données d'adresse.
- **`AllExceptionsFilter`** : propage les détails métier additionnels du body de l'exception (ex: `reason`) sans écraser la forme principale (`statusCode`, `error`, `message`, `path`, `timestamp`). Whiteliste anti-fuite.

#### Stats finales Sprint 2

- **63 tests unit verts** (46 Build + 17 Verify §D) — `pnpm --filter @cc/api test`
- **51 tests intégration verts** (16 Auth + 1 rate-limit + 13 Build + 21 Verify) — `pnpm --filter @cc/api run test:integration`
- **typecheck + lint propres** — `pnpm typecheck && pnpm lint`
- **Aucune nouvelle dette introduite** — les 4 dettes Build acceptées (`debt-matching-async-queue`, `debt-listing-expiration-queue`, `debt-mission-distance-display`, `debt-coverage-report`) restent inchangées.

---

### Build — PRD-002 Missions & Géolocalisation (Ticket 2.2)

Implémentation complète du cycle de vie mission (CREATE → PUBLISH → matching PostGIS → ACCEPT) en respectant les 7 contraintes CTO Build (audit `MissionEvent`, `missionNumber` immuable serveur, matching paginé/borné, masquage adresse pré-acceptation, exclusions matching, transitions via `assertMissionTransition`, zéro logique en controllers).

#### Added — API NestJS (`apps/api/src/modules/missions/`)

- **HTTP**
  - `POST /api/v1/missions` (CLIENT) — création brouillon + géocodage BAN ou GPS mobile.
  - `POST /api/v1/missions/:id/publish` (CLIENT owner) — `DRAFT → PUBLISHED`, calcule `listingExpiresAt`, déclenche le matching.
  - `POST /api/v1/missions/:id/accept` (PRESTATAIRE) — lock optimiste SQL first-wins (ADR-005), `200 ACCEPTED` ou `409 MISSION_ALREADY_ACCEPTED`.
  - `DELETE /api/v1/missions/:id` (CLIENT owner) — `DRAFT/PUBLISHED → CANCELLED`.
  - `GET /api/v1/missions/mine` (CLIENT) — listing paginé cursor-based.
  - `GET /api/v1/missions/proposed` (PRESTATAIRE) — missions matchées non expirées.
  - `GET /api/v1/missions/:id` — RBAC + masquage adresse via `mission-address.policy`.
  - `GET /api/v1/admin/missions` (ADMIN) — listing global paginé.
- **Domaine pur** : `mission-state.machine` (transitions strictes typées), `mission-address.policy` (masquage CP partiel), `mission-event.types` (`assertNoAddressLeak` récursif).
- **Services** : `MissionsService`, `MissionNumberService` (`CC-YYYY-XXXXXXXX`), `MissionEventService` (audit), `GeocoderService` (BAN + retry/timeout, fallback GPS), `MatchingService` (PostGIS `ST_DWithin`), `MissionViewService` (sérialisation + policy).
- **Repository** : `missions.repository.ts` — `$queryRaw` PostGIS pour insertion `addresses.location` (geography(Point, 4326)), matching paginé borné par `MATCHING_MAX_PROVIDERS` (défaut 50), UPDATE conditionnels atomiques.
- **Errors** : `missions.errors.ts` — codes stables `MISSION_NOT_FOUND / FORBIDDEN / INVALID_STATE / ALREADY_ACCEPTED / NOT_ELIGIBLE / GEOCODING_FAILED / VALIDATION_FAILED`.
- **Pino redactor** étendu (`app.module.ts`) : `req.body.address.street`, `req.body.address.location`, `*.street`, `*.location.lat/lng`.

#### Added — Schéma DB

- **Migration** `20260512200000_prd002_mission_events_user_status` (additive, non destructive) :
  - `users.verified_at TIMESTAMPTZ DEFAULT NOW()` — null ⇒ exclusion matching.
  - `users.suspended_at TIMESTAMPTZ NULL` — non-null ⇒ exclusion matching.
  - Table `mission_events` (`id, mission_id, type, actor_user_id?, payload?, created_at`) + index `(mission_id, created_at)` et `(type)`.

#### Added — Shared types (`packages/shared-types/src/zod/mission.ts`)

- `missionAddressInputSchema`, `missionViewSchema`, `missionListQuerySchema`, `missionListResponseSchema`, `missionAddressViewSchema` (discriminated `MASKED | FULL`), `missionEventTypeSchema`, `missionErrorCodeSchema`.

#### Added — Tests

- **Unit (46 verts)** : state machine, address policy, no-address-leak, mission number, geocoder.
- **Integration (33 verts, dont 13 missions)** sur Postgres+PostGIS éphémère :
  - flow nominal CREATE → PUBLISH → ACCEPT
  - exclusion matching : suspendus / non vérifiés / soft-deleted / hors rayon
  - masquage adresse pré-acceptation puis FULL post-ACCEPT
  - **race accept first-wins** (`Promise.all` 2 prestataires) → `[200, 409]` garantis
  - RBAC : autre CLIENT → 403, PRESTATAIRE sur POST → 403, ADMIN voit FULL
  - state machine : publish post-CANCEL → 409
  - listing expiration : `expireIfStillProposed` après backdate → `EXPIRED` + audit
  - Validation Zod : `endAt < startAt` → 400

#### Configuration

- `MISSION_LISTING_TTL_MS` (défaut 15 min, validé `[1s, 24h]`).
- `MATCHING_MAX_PROVIDERS` (défaut 50, max 500).
- `BAN_BASE_URL` (défaut `https://api-adresse.data.gouv.fr`) + `BAN_TIMEOUT_MS` (défaut 5 s).

#### Technical debt (Build, suivi)

| Slug | Description | Priorité |
|---|---|---|
| `debt-matching-async-queue` | Matching synchrone dans `publish()` ; à basculer en BullMQ producer/consumer si volume > 100 missions/min | M |
| `debt-listing-expiration-queue` | `expireIfStillProposed` invocable mais pas branché sur job BullMQ delayed ni cron — à câbler avant ouverture marketplace publique | M |
| `debt-mission-distance-display` | `MaskedMissionAddress.approximateDistanceKm` renvoyé à 0 (UI = "à proximité"). Calcul réel (croisement adresses) en future itération | L |
| `debt-coverage-report` | Pas de seuil `coverage >= 80%` enforced en CI | L |

#### Documentation

- PRD : [`docs/prd/PRD-002-missions-geolocalisation.md`](docs/prd/PRD-002-missions-geolocalisation.md) v0.3 (Build) — DoD §5.7 cochée sauf audit reviewer + sign-off CTO.

---

## [v0.1.0-auth-foundation] — 2026-05-12

Premier vertical slice livré de bout en bout via la méthode [BMAD-light](docs/method/BMAD.md).
Auth = fondation officielle de toute la plateforme : rôles, sessions, guards, bootstrap mobile, sécurité JWT, rate limiting, refresh rotation.

### Added

- **API NestJS** (`apps/api/src/modules/auth/`) — module `Auth` complet :
  - `POST /api/v1/auth/signup` (CLIENT/PRESTATAIRE, ADMIN exclu), `/login`, `/refresh`, `/logout`, `GET /me`.
  - `JwtAccessStrategy` + `JwtAccessGuard` + `RolesGuard` séparés (cf. [ADR-004](docs/adr/ADR-004-auth-tokens-strategy.md)).
  - `bcrypt` cost 10 pour passwords ; refresh tokens opaques 48 bytes hachés en SHA-256 en DB.
  - Rotation transactionnelle (`prisma.$transaction`) + cascade revoke sur replay détecté.
  - `ConditionalThrottlerGuard` — rate limiting per-route (signup 5/min, login 10/min, refresh 30/min) avec bypass `DISABLE_THROTTLE` interdit en production (crash boot `env.ts`).
- **Mobile Expo** (`apps/mobile/src/features/auth/`) — Zustand store + `expo-secure-store` + écrans Login/Signup + `AuthBootstrap` au démarrage + `/auth/me` source de vérité (zéro JWT decode client-side).
- **Schémas Zod partagés** (`packages/shared-types/src/zod/auth.ts`) — DTOs `.strict()` + blocklist mots de passe.
- **Migration Prisma** `20260512130000_pr001_refresh_tokens_and_user_names` — modèle `RefreshToken` + `firstName`/`lastName` sur `User`.
- **Documentation** :
  - PRD : [`docs/prd/PRD-001-auth-jwt.md`](docs/prd/PRD-001-auth-jwt.md) (v0.5, statut `DONE`).
  - ADR : [`docs/adr/ADR-004-auth-tokens-strategy.md`](docs/adr/ADR-004-auth-tokens-strategy.md).
  - Pré-revue Design : [`docs/security-reviews/2026-05-12-prd-001-auth-design-prereview.md`](docs/security-reviews/2026-05-12-prd-001-auth-design-prereview.md).
  - **Audit final** : [`docs/security-reviews/2026-05-12-prd-001-auth-verify.md`](docs/security-reviews/2026-05-12-prd-001-auth-verify.md) — Verdict ✅ Merge OK (0 Critique / 0 Important non traité).
- **Tests** :
  - API unit : 24/24 (`auth.service`, `token.service`, `password.service`, `health`).
  - API intégration : 20/20 (`auth-flow` 19 scénarios CTO + `auth-rate-limit` 1 scénario throttler).
  - Mobile unit : 18/18 (`auth.store`, `auth-errors`).
- **CI** : 3 jobs verts (Quality / Integration Postgres+Redis / Build Docker).

### Fixed

Faux-verts détectés et corrigés pendant la phase Verify (Ticket 1.6) :

- **Double pipe global** dans `apps/api/src/main.ts` — `ValidationPipe` (class-validator) + `ZodValidationPipe` (APP_PIPE) cumulaient et rejetaient les props déjà validées par Zod. Retrait du `ValidationPipe` ; `ZodValidationPipe` reste l'unique pipe global, `.strict()` Zod fait whitelist.
- **`jest.integration.config.ts`** — `testPathIgnorePatterns` héritait du config unitaire et excluait `*.integration.spec.ts` → faux-vert CI (0 tests). Override explicite + `setupFiles` (`jest-env.setup.ts`) + `testTimeout: 120s`.

### Technical debt (suivi post-merge)

| Slug | Description | Priorité |
|---|---|---|
| `debt-throttle-composite` | Clé throttler IP-only ; IP+email reporté | M |
| `debt-password-blocklist` | Étendre la blocklist vers OWASP top 10k | M |
| `debt-error-envelope` | Clients consomment `error` field (envelope non standardisée RFC 7807) | L |
| `debt-mobile-ui-polish` | DA finale post-PRD design | M |
| `debt-mobile-active-role` | `AsyncStorage` pour la préférence de rôle, MMKV reporté | L |
| `debt-mobile-component-tests` | Tests RN composants (Detox / Maestro) | M |
| `debt-integration-coverage-report` | Gate coverage intégration | L |
| S1 — Swagger Bearer nominatif `@ApiBearerAuth('access-jwt')` | DX | L |
| S2 — `/logout` throttle + doc explicite ADR-004 | DX/sécu | L |

### Stack figée

- NestJS 10 + Prisma 5 + Postgres 16 + PostGIS 3.4 + Redis 7
- nestjs-zod + nestjs-pino + @nestjs/throttler + @nestjs/jwt + passport-jwt
- Expo SDK 54 + React Native + Zustand + expo-secure-store + react-hook-form + zod
- Turborepo + pnpm workspaces

---

*Référence méthode : [BMAD-light](docs/method/BMAD.md) — toutes les features suivent les 4 phases Discover → Design → Build → Verify.*
