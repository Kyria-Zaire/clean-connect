# Changelog

Toutes les modifications notables apportées à Clean Connect sont consignées dans ce fichier.

Le format est inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

Chaque entrée référence le PRD pilote (cf. [`docs/prd/README.md`](docs/prd/README.md))
et le rapport sécurité associé (`docs/security-reviews/`).

---

## [Unreleased]

### Design — PRD-002 Missions & Géolocalisation (Ticket 2.1)

- **Prisma** : modèle `Mission` refondu (`missionNumber`, `serviceType`, fenêtre temporelle, `estimatedPriceCents`, statuts lifecycle + états réservés PRD aval), table `mission_proposals`, `users.service_radius_km` (15–30 km).
- **Migration** `20260512190000_prd002_mission_lifecycle_design` : **breaking** pré-prod (truncate missions/photos).
- **Shared types** : `MissionStatusSchema`, `MissionServiceTypeSchema`, `createMissionDraftBodySchema` (`packages/shared-types/src/zod/mission.ts`).
- **Domaine API** : `mission-state.machine.ts`, `mission-address.policy.ts` + tests unitaires.
- **ADR** : [ADR-005](docs/adr/ADR-005-missions-matching-marketplace.md), [ADR-006](docs/adr/ADR-006-geocoding-ban-mobile-fallback.md), [ADR-007](docs/adr/ADR-007-mission-pricing-placeholder.md).
- **Pré-revue sécu Design** : [`docs/security-reviews/2026-05-12-prd-002-missions-design-prereview.md`](docs/security-reviews/2026-05-12-prd-002-missions-design-prereview.md).
- **PRD** : [`docs/prd/PRD-002-missions-geolocalisation.md`](docs/prd/PRD-002-missions-geolocalisation.md) v0.2 — **Build interdit** sans sign-off CTO Design.

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
