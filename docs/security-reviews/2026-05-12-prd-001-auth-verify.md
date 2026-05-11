# Audit Sécurité — Verify PRD-001 Auth JWT (rapport final pré-merge)

**Auditeur** : Reviewer Sécurité Code (méthode `reviewer-securite-code.mdc`)
**Cible** :
- `apps/api/src/modules/auth/**` (controller, service, DTO, guards, strategies, services)
- `apps/api/src/common/config/env.ts`
- `apps/api/src/common/filters/all-exceptions.filter.ts`
- `apps/api/src/common/guards/conditional-throttler.guard.ts` (introduit en Verify)
- `apps/api/src/app.module.ts` (redactor Pino + Throttler)
- `apps/api/src/main.ts` (Swagger, helmet, CORS, prefix `/api/v1`)
- `apps/api/prisma/schema.prisma` (`User`, `RefreshToken`)
- `apps/api/test/integration/auth-flow.integration.spec.ts` + `auth-rate-limit.integration.spec.ts`
- `apps/mobile/src/features/auth/**` (api, storage, store, hooks, screens, types)
**Branche** : `feat/prd-001-auth-jwt`
**Commits inspectés** : `bf87dff` (Design), `c3852a9` (Build API), `80e4d3a` (Mobile Bootstrap), `36212df` (Tests consolidés) + commit Verify (ce ticket).
**Date** : 2026-05-12
**Verdict** : ✅ **Merge OK — 0 Critique / 0 Important non traité / 3 Suggestions de suivi.**

> 🔧 **Faux-verts détectés et corrigés en Verify** (Ticket 1.6, autorisé par le scope CTO « corrections uniquement si Verify/CI échoue ») :
> 1. **Double pipe global** (`ValidationPipe` class-validator + `ZodValidationPipe` APP_PIPE) dans `main.ts` → toutes les requêtes échouaient en 400 « property X should not exist » car `forbidNonWhitelisted` rejette ce que Zod a déjà validé. ❗ Bug masqué jusqu'ici par le précédent faux-vert `testPathIgnorePatterns`. **Fix** : retrait de `useGlobalPipes(ValidationPipe)` ; `ZodValidationPipe` (APP_PIPE) reste l'unique pipe.
> 2. **Throttler bloquait les tests d'intégration métier** (5/min signup ≠ 19 tests). **Fix** : nouveau `ConditionalThrottlerGuard` lisant `DISABLE_THROTTLE`, **crash boot en `NODE_ENV=production`** si activé (cf. `env.ts:superRefine`). Suite `auth-rate-limit.integration.spec.ts` ajoutée pour réactiver le throttler et confirmer le 429.
>
> Ces deux corrections sont elles-mêmes inspectées dans la section 🟢 ci-dessous.

---

## 🔴 Critique (0 finding)

*Aucun.*

---

## 🟠 Important (0 finding non traité)

Les 5 conditions de la pré-revue Design [`2026-05-12-prd-001-auth-design-prereview.md`](2026-05-12-prd-001-auth-design-prereview.md) ont été **toutes traitées** en Build (Ticket 1.3) et **revérifiées** en Verify (Ticket 1.6) :

| Pré-revue | Traitement Build (référence code) | Vérification Verify |
|---|---|---|
| **I1** Secrets JWT distincts | `apps/api/src/common/config/env.ts:57-66` — `superRefine` ajoute une `ZodIssueCode.custom` si `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET` ; `min(48)` sur les deux. `loadEnv()` `throw` au boot, empêchant le démarrage. | Re-lu. Crash boot reproduit dans Discover/Build (cf. PRD §5.2). |
| **I2** DTO Zod + ZodValidationPipe | `apps/api/src/modules/auth/dto/auth.dto.ts` (`createZodDto` x6) ; `apps/api/src/app.module.ts:73` enregistre `ZodValidationPipe` en `APP_PIPE` global. Aucune route ne lit `req.body` brut. | Tests intégration `2` & `4` (signup ADMIN / WEAK_PASSWORD) renvoient `400 ValidationError` et confirment le pipeline Zod. |
| **I3** Rate limits per-route | `auth.controller.ts:50,69,81` — `@Throttle({ default: { limit: 5, ttl: 60_000 } })` signup, `10/min` login, `30/min` refresh. `ThrottlerGuard` global via `APP_GUARD`. | Conforme PRD §4.3. Dette `debt-throttle-composite` (clé IP+email) acceptée par le CTO en Build. |
| **I4** Logs sans PII | `app.module.ts:30-50` — redactor Pino sur `*.password`, `*.passwordHash`, `*.accessToken`, `*.refreshToken`, `*.tokenHash`, `*.email`, `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`. `auth.service.ts` ne logge que `event`, `userId`, `role`, `reason`. | Grep `console\.(log\|warn\|error)` sur `apps/api/src/modules/auth` : **0 occurrence**. Idem `apps/mobile/src/features/auth` : 0. |
| **I5** Transaction rotation refresh | `auth.service.ts:166-178` — `prisma.$transaction([update(revokedAt), create(next)])`. | Test intégration `8 — refresh OK` interroge Prisma : 2 lignes, l'ancien `revokedAt!=null`, le nouveau actif. |

---

## 🟡 Suggestion (3 findings — non bloquants merge, dettes documentées)

### S1 — `@ApiBearerAuth()` non lié au nom Swagger `'access-jwt'`

- **Fichier** : `apps/api/src/main.ts:57` (`.addBearerAuth({...}, 'access-jwt')`) vs `apps/api/src/modules/auth/auth.controller.ts:105` (`@ApiBearerAuth()` sans argument).
- **Constat** : Swagger UI affiche bien le badge sur `/me` et le bouton « Authorize » fonctionne (le seul scheme défini est sélectionné par défaut), mais le mapping nominatif n'est pas explicite. Aucun impact sécu, purement DX/lisibilité.
- **Mitigation suggérée** (post-MVP, ticket dédié) : `@ApiBearerAuth('access-jwt')` sur `auth.controller.ts:105`.
- **Sévérité** : 🟡 Suggestion.

### S2 — `/logout` non protégé par `JwtAccessGuard` (par design, à documenter)

- **Fichier** : `auth.controller.ts:93-101`.
- **Constat** : `POST /api/v1/auth/logout` accepte `refreshToken` dans le body, **sans** `@UseGuards(JwtAccessGuard)` ni `@ApiBearerAuth()`. C'est **volontaire** — la possession d'un refresh token valide vaut preuve (ADR-004), ce qui permet au mobile de logout même si l'access est expiré (cas typique cold start sans refresh single-flight).
- **Risque** : Très faible. Endpoint idempotent qui ne révoque qu'un refresh donné ; si un attaquant a déjà le refresh, il a mieux à faire que de logout. Pas de rate-limit, mais l'endpoint ne déclenche aucune notification / pas d'effet de bord exploitable.
- **Mitigation suggérée** (post-MVP) : ajouter un `@Throttle({ default: { limit: 30, ttl: 60_000 } })` pour éviter le harcèlement DB ; documenter le choix dans ADR-004 §"Logout".
- **Sévérité** : 🟡 Suggestion. **Non bloquant** car la sémantique « refresh = preuve » est documentée (PRD-001 §4.3 + ADR-004).

### S3 — Couverture coverage non gatée sur les tests d'intégration

- **Fichier** : `apps/api/jest.integration.config.ts` (pas de `--coverage` Turbo).
- **Constat** : `pnpm --filter @cc/api test:cov` couvre les unit tests, mais le job CI `integration` ne produit pas de rapport coverage. Tracé en dette `debt-integration-coverage-report` (PRD §5.9).
- **Mitigation** : ticket dédié post-MVP.
- **Sévérité** : 🟡 Suggestion.

---

## 🟢 Conforme (preuves rangées par checklist CTO Ticket 1.6)

### 1. Aucun `passwordHash` exposé

- **Code** : `auth.service.ts:225-233` (`toPublicUser()` whiteliste `id`, `email`, `role`, `firstName`, `lastName`, `createdAt` ; pas de `passwordHash`).
- **Tests** : `auth-flow.integration.spec.ts` it `1`, `15` — `assertNoLeakedSecrets()` parcourt récursivement la réponse, lève si la clé `passwordHash` (case-insensitive) apparaît.

### 2. Aucun `tokenHash` exposé

- **Code** : Aucun endpoint ne retourne d'objet `RefreshToken`. Le hash est uniquement lu par `auth.service.ts:117` (`findUnique({ where: { tokenHash } })`).
- **Tests** : `assertNoLeakedSecrets()` couvre aussi `tokenHash` ; exécuté sur `signup`, `login`, `refresh`, `me`, et les réponses d'erreur.

### 3. Aucun `accessToken` / `refreshToken` dans les logs

- **Code** :
  - `app.module.ts:30-50` — redactor Pino étendu (`*.accessToken`, `*.refreshToken`, `*.tokenHash`, `req.body.refreshToken`, `req.body.accessToken`, `res.headers["set-cookie"]`, censor `[REDACTED]`).
  - Audit `apps/api/src/modules/auth` : `0` occurrence de `console.(log|warn|error)`.
  - `auth.service.ts` events structurés : `auth.signup.success`, `auth.login.success/failure(reason)`, `auth.refresh.rotation`, `auth.refresh.replay_detected`, `auth.refresh.failure(reason)`, `auth.logout(revoked count)` — **aucune valeur de token n'est passée au logger**.
- **Mobile** : `apps/mobile/src/features/auth/api/auth-api.ts` et `auth.store.ts` — `0` `console.*` ; les `AuthApiError` ne portent que `code` + message UI générique (jamais le body brut).

### 4. Refresh token stocké uniquement en SHA-256

- **Code** :
  - `token.service.ts:63-74` — `issueRefreshToken()` génère `crypto.randomBytes(48).toString('base64url')` et calcule immédiatement `sha256(token).digest('hex')` (64 chars).
  - `auth.service.ts:208-216` (issueSessionFor), `:170-178` (rotation), `:189-191` (logout) — Prisma ne reçoit que `tokenHash`, jamais le token clair.
  - `prisma/schema.prisma:110` — `tokenHash String @unique @db.VarChar(64)` — pas de colonne `token` en clair.
- **Tests** : `token.service.spec.ts` vérifie `tokenHash` match `/^[0-9a-f]{64}$/u` et `≠ token`. `auth.service.spec.ts` vérifie l'argument de `prisma.refreshToken.create` (`data.tokenHash` est un hex 64).

### 5. Rotation refresh effective

- **Code** : `auth.service.ts:160-180` — `prisma.$transaction([update(revokedAt=now), create(next)])`. Le client reçoit un **nouveau** `accessToken` + **nouveau** `refreshToken`.
- **Tests** : intégration `8 — refresh OK` lit Prisma post-rotation : `rows.length === 2`, `rows[0].revokedAt !== null`, `rows[1].revokedAt === null`, `r2 !== r1`.

### 6. Replay refresh => cascade revoke

- **Code** : `auth.service.ts:129-140` — détection `stored.revokedAt != null` → `prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } })` + log `auth.refresh.replay_detected` + `UnauthorizedException`.
- **Tests** : intégration `9 — cascade` : 2 sessions ouvertes (r1, r2), rotation r1 → r1' OK, replay r1 → 401, **r2** (autre session) → 401.

### 7. `JWT_ACCESS_SECRET` et `JWT_REFRESH_SECRET` obligatoires et différents

- **Code** : `env.ts:18-19,57-66` — `min(48)` + `superRefine` égalité interdite. Au boot, `loadEnv()` `throw` si invalide.
- **Tests** : test unitaire impossible à automatiser sans process restart, mais la règle est lue par `ConfigModule.forRoot({ validate: () => loadEnv() })` au démarrage Nest.

### 8. `/auth/me` protégé

- **Code** : `auth.controller.ts:103-110` — `@UseGuards(JwtAccessGuard)` + `@ApiBearerAuth()` + `@CurrentUser()`.
- **Tests** : intégration `12` (no Bearer → 401), `13` (Bearer valide → 200), `14` (Bearer valide MAIS user soft-deleted → 401 `INVALID_CREDENTIALS`).

### 9. ADMIN impossible au signup public

- **Code** : `packages/shared-types/src/zod/auth.ts:13` — `authSignUpPublicRoleSchema = z.enum(['CLIENT', 'PRESTATAIRE'])` ; `authSignUpRequestBodySchema` utilise ce schema. Toute valeur `'ADMIN'` est rejetée au pipe Zod avant d'arriver au service.
- **Tests** : intégration `2 — signup ADMIN refusé (400)` + unit (login schema Zod).

### 10. Erreurs login génériques

- **Code** : `auth.service.ts:98-107` — branches `user inconnu`, `user soft-deleted`, `mauvais password` retournent toutes `UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS })`. Les logs distinguent (`reason: unknown_or_deleted` vs `bad_password`) mais la réponse HTTP est identique.
- **Tests** : intégration `6` (bad password) et `7` (soft-deleted) — même code `INVALID_CREDENTIALS`.

### 11. Rate limits présents

- **Code** : `auth.controller.ts` — `@Throttle` sur signup (5/min), login (10/min), refresh (30/min). `ConditionalThrottlerGuard` enregistré `APP_GUARD` (extends `ThrottlerGuard`). Limite globale par défaut via `ThrottlerModule.forRootAsync` (`THROTTLE_LIMIT=120`, `THROTTLE_TTL_SECONDS=60`).
- **Tests** : `auth-rate-limit.integration.spec.ts` — 6e signup depuis la même IP renvoie 429. La désactivation via `DISABLE_THROTTLE=true` est documentée, **interdite en `NODE_ENV=production`** (Zod `superRefine` lève au boot).
- **Limitation** : dette `debt-throttle-composite` — clé IP seule, pas IP+email. Acceptée par CTO Build.

### 13. Bug correction Verify — pipe global unique (`ZodValidationPipe`)

- **Code** : `main.ts:42-46` — commentaire explicite, **plus aucun** `useGlobalPipes(new ValidationPipe(...))`. Le seul pipe global est `ZodValidationPipe` enregistré dans `app.module.ts:74` via `APP_PIPE`. Toutes les routes auth utilisent `createZodDto(...)` (`auth.dto.ts`), donc le pipeline reste strictement Zod end-to-end.
- **Risque sécu** : Aucun. L'ancien `whitelist: true / forbidNonWhitelisted: true` est dupliqué par le `.strict()` Zod (`packages/shared-types/src/zod/auth.ts:24,43,51`) qui rejette toute propriété inconnue. La réponse aux tentatives d'injection (`{ role: 'ADMIN' }`, props supplémentaires) reste 400 `ValidationError`.
- **Tests** : `auth-flow.integration.spec.ts` (cas 1–16, tous verts) prouve que le payload valide passe et que les payloads invalides sont rejetés.

### 14. Bug correction Verify — `ConditionalThrottlerGuard`

- **Code** : `apps/api/src/common/guards/conditional-throttler.guard.ts` (24 lignes, lit `process.env.DISABLE_THROTTLE === 'true'` ; sinon délègue à `super.canActivate()`). Pas de `loadEnv()` pour permettre un toggling dynamique entre suites de tests.
- **Filet sécurité** : `env.ts:superRefine` rejette `DISABLE_THROTTLE=true` en `NODE_ENV=production` → crash boot. Le filet est unitairement vérifiable mais non testé automatiquement (rare régression possible, documentée comme acceptable).
- **Risque sécu** : Limité. Désactiver le throttler nécessite (a) accès à l'env var sur le serveur, (b) `NODE_ENV != production`. En recette/preprod, le rate-limit reste actif par défaut.
- **Tests** : `auth-rate-limit.integration.spec.ts` (set `DISABLE_THROTTLE=false`) confirme que le throttler fonctionne nominalement.

### 12. Soft-deleted users refusés

- **Code** : `auth.service.ts:98` (login), `:151` (refresh), `:201` (getMe) — `if (!user || user.deletedAt)` → 401 (`INVALID_CREDENTIALS` ou `INVALID_REFRESH_TOKEN`).
- **Tests** : intégration `7`, `14`, `16` — 3 chemins (login / me / refresh) avec user soft-deleted produisent 401.

---

## Vérification Swagger (statique — `apps/api/src/main.ts` + `auth.controller.ts`)

Le serveur ne peut pas être démarré pour cette revue (pas de Postgres local sur la machine d'audit). Vérification **statique** des annotations OpenAPI exposées :

| Endpoint | Method | DTO entrée | Response 2xx | Status d'erreur documentés | BearerAuth | Throttle |
|---|---|---|---|---|---|---|
| `/api/v1/auth/signup` | POST | `SignUpRequestDto` | 201 `SessionResponseDto` | 400, 409, 429 | — | 5/60s |
| `/api/v1/auth/login`  | POST | `LoginRequestDto` | 200 `SessionResponseDto` | 401, 429 | — | 10/60s |
| `/api/v1/auth/refresh`| POST | `RefreshRequestDto` | 200 `RefreshResponseDto` | 401 | — | 30/60s |
| `/api/v1/auth/logout` | POST | `LogoutRequestDto` | 204 (idempotent) | — | — (S2) | — |
| `/api/v1/auth/me`     | GET  | — | 200 `MeResponseDto` | 401 | ✅ `@ApiBearerAuth()` | — |

`DocumentBuilder` (`main.ts:53-58`) déclare `addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-jwt')` ; Swagger UI exposé sur `/api-docs` **uniquement hors `production`** (`main.ts:52`). `patchNestJsSwagger()` enregistré pour générer la doc à partir des schémas Zod (`nestjs-zod`).

**Checklist CTO** :
- ✅ Présence des 5 endpoints sous `/v1/auth/*`
- ✅ DTOs et responses lisibles (`createZodDto` génère le `examples` Swagger via `nestjs-zod`)
- ✅ BearerAuth sur `/me`
- ⚠️ BearerAuth **absent** sur `/logout` — comportement attendu (S2) ; à reconfirmer fonctionnellement quand l'API est démarrée

> Validation manuelle Swagger UI à réeffectuer lors de la première mise en route locale ou recette (`pnpm --filter @cc/api dev` + `http://localhost:3000/api-docs`). Ne change rien à la décision merge.

---

## Synthèse

| Sévérité | Compte |
|---|---|
| 🔴 Critique | 0 |
| 🟠 Important | 0 (5/5 conditions Design traitées + 2 faux-verts Verify corrigés) |
| 🟡 Suggestion | 3 (S1, S2, S3) — tickets de suivi acceptés |
| 🟢 Conforme | 14 points (checklist CTO complète + 2 corrections Verify) |

---

## Décision

✅ **Merge autorisé** sur `main` après :
1. Push de `feat/prd-001-auth-jwt`
2. CI verte (Quality + Integration + Docker build)
3. Validation humaine CTO finale (PRD §5.8 + ce rapport)

**Dettes restantes (suivi post-merge, non bloquantes)** :
- `debt-throttle-composite` (clé IP+email login)
- `debt-password-blocklist` (étendre vers OWASP top 10k)
- `debt-error-envelope` (clients consomment `error` field)
- `debt-mobile-ui-polish` (DA finale post-PRD design)
- `debt-mobile-active-role` (AsyncStorage → MMKV)
- `debt-mobile-component-tests` (Detox / Maestro)
- `debt-integration-coverage-report` (gate coverage intégration)
- `S1` Swagger Bearer nominatif (`@ApiBearerAuth('access-jwt')`)
- `S2` `/logout` throttle + doc explicite ADR-004
- `S3` coverage intégration

---

*Audit Verify final — PRD-001 — Clean Connect.*
