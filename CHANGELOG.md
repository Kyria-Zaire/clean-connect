# Changelog

Toutes les modifications notables apportées à Clean Connect sont consignées dans ce fichier.

Le format est inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

Chaque entrée référence le PRD pilote (cf. [`docs/prd/README.md`](docs/prd/README.md))
et le rapport sécurité associé (`docs/security-reviews/`).

---

## [Unreleased]

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
