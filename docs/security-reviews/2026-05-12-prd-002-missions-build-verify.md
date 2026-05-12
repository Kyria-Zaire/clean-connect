# Security Review — PRD-002 Missions Build (phase Verify)

| Champ        | Valeur |
|--------------|--------|
| **PRD**      | [`docs/prd/PRD-002-missions-geolocalisation.md`](../prd/PRD-002-missions-geolocalisation.md) |
| **Branche**  | `feat/prd-002-missions-build` |
| **PR**       | [#4](https://github.com/Kyria-Zaire/clean-connect/pull/4) |
| **Reviewer** | CTO (délégation à `architecte-api` + `reviewer-securite-code`) |
| **Date**     | 2026-05-12 |
| **Conclusion** | ✅ **APPROVED — merge autorisé** |

---

## 1. Résumé exécutif

Le Build PRD-002 (Missions & Géolocalisation) a été audité contre les **5 contrôles CTO Verify obligatoires** (A → E) plus une revue transverse (RBAC, Swagger, redactor, payload audit, race conditions PostGIS).

**Aucune faille bloquante détectée.** Deux corrections mineures appliquées en Verify (cf. §4) pour remonter la qualité du périmètre déjà livré, sans ajout de feature.

| Audit | Résultat | Test associé |
|-------|----------|--------------|
| **A — Idempotence accept (double POST)**           | ✅ | `missions-verify A.1` |
| **B — Race cancel vs accept**                       | ✅ | `missions-verify B.1` + `B.2` |
| **C — Visibility policy admin (full + redacted)**   | ✅ | `missions-verify C.1` + redactor Pino global |
| **D — MissionEvent payload hygiene (PII + secrets)**| ✅ | `missions-verify D.*` (8 cas + 1 positif) |
| **E — Race expiration vs accept**                   | ✅ | `missions-verify E.1` + `E.2` |

---

## 2. Périmètre audité

| Couche | Fichier(s) |
|--------|------------|
| HTTP (controllers — pas de logique métier) | `apps/api/src/modules/missions/missions.controller.ts`, `admin-missions.controller.ts` |
| Service métier + state machine             | `missions.service.ts`, `domain/mission-state.machine.ts` |
| Domain hygiene (audit payload)             | `domain/mission-event.types.ts`, `domain/mission-address.policy.ts` |
| Repository (PostGIS + lock optimiste)      | `missions.repository.ts` |
| Services support                           | `mission-event.service.ts`, `mission-view.service.ts`, `geocoder.service.ts`, `matching.service.ts`, `mission-number.service.ts` |
| Filter HTTP (mapping erreurs)              | `apps/api/src/common/filters/all-exceptions.filter.ts` |
| Logger (redactor PII)                      | `apps/api/src/app.module.ts` (Pino `redact.paths`) |

---

## 3. Détail des 5 audits CTO

### 3.1 — Audit A — Idempotence accept mission (même provider)

**Exigence CTO** : « double POST `/accept` du même prestataire ⇒ jamais de double event ni de double mutation. »

**Code audité**

`apps/api/src/modules/missions/missions.service.ts` — méthode `accept()` :
- Court-circuit `if (mission.status === 'ACCEPTED') throw new MissionAlreadyAcceptedError()` exécuté **AVANT** la transaction et **AVANT** `assertMissionTransition` (qui interdirait `ACCEPTED → ACCEPTED`).
- L'`UPDATE` conditionnel (`status='PUBLISHED'`) n'est jamais atteint au 2ᵉ appel.
- L'`event ACCEPTED` est inséré dans la **même `$transaction`** que la mutation, et **uniquement si** `count === 1`.

**Vérification (test `missions-verify A.1`)**
- 1ᵉʳ POST `/accept` → 200, mission ACCEPTED, exactement 1 event `ACCEPTED`.
- 2ᵉ POST `/accept` même provider → 409 `MISSION_ALREADY_ACCEPTED`.
- Snapshot `mission.updated_at` identique avant/après le 2ᵉ POST.
- `count(mission_events WHERE type='ACCEPTED')` reste à **1**.
- `count(mission_events) total` inchangé.

✅ **Pas de mutation et pas d'event en doublon.**

> **Note design** : on renvoie `409 MISSION_ALREADY_ACCEPTED` et pas `200` idempotent (re-renvoi de la `MissionView`). Les deux sont valides REST. Le 409 est plus explicite et pousse le client à re-`GET` la mission ; il est documenté en Swagger. Pas de changement requis.

---

### 3.2 — Audit B — Race cancel vs accept

**Exigence CTO** : « provider accept concurrent avec cancel client ⇒ état final cohérent garanti. »

**Code audité**
- `MissionsRepository.transitionToCancelledTx` : `WHERE status IN ('DRAFT','PUBLISHED')` (UPDATE conditionnel).
- `MissionsRepository.transitionPublishedToAcceptedTx` : `WHERE status='PUBLISHED' AND listingExpiresAt > now AND proposals.some(prestataireId=…)` (UPDATE conditionnel).
- Les deux `WHERE` sont mutuellement exclusifs au niveau Postgres : **un seul UPDATE écrit `count=1`**.

**Correction Verify (B + E)** : la branche post-update de `MissionsService.accept()` distinguait mal `ALREADY_ACCEPTED` vs `INVALID_STATE`. Désormais :

```ts
if (updatedCount !== 1) {
  const fresh = await this.repo.findById(missionId)
  switch (fresh?.status) {
    case 'ACCEPTED':  throw new MissionAlreadyAcceptedError()
    case 'CANCELLED': throw new MissionInvalidStateError('mission_cancelled')
    case 'EXPIRED':   throw new MissionInvalidStateError('mission_expired')
    case 'PUBLISHED': throw new MissionNotEligibleError()
    default:          throw new MissionInvalidStateError('mission_state_changed_concurrently')
  }
}
```

Et `toInvalidStateError()` produit désormais un `reason` sémantique stable (`mission_cancelled` / `mission_expired` / `mission_already_accepted`) plutôt que la forme brute `CANCELLED->ACCEPTED`, pour permettre au front un mapping i18n robuste.

**Vérification (tests `missions-verify B.1` + `B.2`)**
- B.1 : cancel précède accept → accept renvoie `409 MISSION_INVALID_STATE` + `reason: 'mission_cancelled'`. État final = `CANCELLED`, `prestataireId=NULL`, **0 event ACCEPTED**.
- B.2 : `Promise.all([accept, cancel])` → un et un seul gagne. Si accept gagne, cancel renvoie 409 `MISSION_INVALID_STATE` (transition `ACCEPTED → CANCELLED` interdite). Si cancel gagne, accept renvoie 409 sur la même base. **`min(acceptedCount, cancelledCount) === 0`** (jamais les deux events finaux validés).

✅ **État final toujours déterministe + 1 seul event terminal.**

---

### 3.3 — Audit C — Visibility policy admin

**Exigence CTO** : « admin voit l'adresse complète, les logs restent redacted. »

**Code audité**
- `MissionViewService.isFullAddressAllowed()` : `if (viewer.role === 'ADMIN') return true` — l'admin reçoit toujours `address.kind = 'FULL'` (street, location lat/lng).
- Redactor Pino global (`apps/api/src/app.module.ts`) avec wildcards `*.street`, `*.location.lat`, `*.location.lng`, `*.email`, `*.passwordHash`, `*.tokenHash`, `*.refreshToken`, `*.accessToken`. **S'applique à toutes les routes, y compris `/admin/missions`** — la sortie console / Pino n'expose jamais les coordonnées en clair, même quand l'admin lit la response complète.

**Vérification**
- Test `missions-verify C.1` : ADMIN appelle `GET /admin/missions`, l'item correspondant à la mission a bien `address.kind === 'FULL'` + `street` + `location` définis.
- Logs Pino observés pendant les runs intégration : champ `authorization` du request header est bien `[REDACTED]` (preuve dans `agent-tools/02dbdfbc-…`). Aucun `street` / `location` brut n'apparaît dans les logs.

✅ **Admin lit l'adresse complète via API ; les logs serveur n'exposent jamais l'adresse même quand l'utilisateur est ADMIN.**

---

### 3.4 — Audit D — MissionEvent payload hygiene

**Exigence CTO** : « aucun payload sensible dans `mission_events` : adresse complète pré-acceptation, email, téléphone, token, JWT, password. »

**Code audité**
- `domain/mission-event.types.ts` étendu en Verify : la fonction (renommée `assertEventPayloadHygiene`, alias rétrocompatible `assertNoAddressLeak`) refuse désormais les clés suivantes (récursivement, à toute profondeur) :
  - **Adresse** : `street*`, `addressLine*`, `fullAddress`, `lat`, `lng`, `latitude`, `longitude`, `location`, `geo`, `coordinates`.
  - **PII** : `email*`, `phone*`, `mobile`, `telephone`.
  - **Secrets** : `password*`, `token`, `accessToken`, `refreshToken`, `tokenHash`, `jwt`, `authorization`, `apiKey`, `secret`.
- Appelée systématiquement par `MissionEventService.recordTx()` **avant** l'insert. Si une clé interdite est présente, l'insert est annulé (la mutation métier rollback dans la même `$transaction`).

**Vérification**
- Tests unitaires `mission-event.types.spec.ts` : 22 cas (anciens + 16 nouveaux Verify §D), tous verts.
- Tests intégration `missions-verify D.*` : pour chacune des 8 catégories (adresse, location, email, phone, token, jwt, password, authorization), `MissionEventService.record()` est appelé avec un payload mauvais et **doit lever** `Error: champ interdit`. Vérification ensuite qu'aucun event n'a été inséré (rollback transaction).
- Cas positif : payload audit légitime (`{ reason: 'too_expensive', refundCents: 4900 }`) inséré sans erreur.

**Audit du code source** — recherche manuelle de tout appel à `events.record(…)` ou `events.recordTx(…)` :
| Site | Payload réel | Verdict |
|------|--------------|---------|
| `MissionsService.createDraft` `CREATED` | `{ serviceType }` | ✅ ok |
| `MissionsService.publish` `PUBLISHED` | `{ listingTtlMs }` | ✅ ok |
| `MissionsService.accept` `ACCEPTED` | aucun | ✅ ok |
| `MissionsService.cancel` `CANCELLED` | `{ reason? }` (string libre validé Zod) | ✅ ok |
| `MissionsService.expireIfStillProposed` `EXPIRED` | `{ reason: 'listing_ttl_elapsed' }` | ✅ ok |
| `MatchingService.runFor` `MATCHING_DONE` | `{ eligibleCount, …ids }` (uniquement userIds opaques) | ✅ ok |

✅ **Aucun chemin de code n'écrit d'adresse complète, d'email, de téléphone ou de secret dans `mission_events`.**

---

### 3.5 — Audit E — Race expiration vs accept

**Exigence CTO** : « mission expirée simultanément à un accept ⇒ cohérence finale garantie. »

**Code audité**
- `transitionPublishedToExpiredTx` : `WHERE status='PUBLISHED' AND listingExpiresAt <= now`.
- `transitionPublishedToAcceptedTx` : `WHERE status='PUBLISHED' AND listingExpiresAt > now`.
- Les deux conditions sur `listingExpiresAt` sont **strictement complémentaires** (`<= now` vs `> now`) ⇒ aucune fenêtre de double exécution possible (Postgres MVCC + UPDATE atomique).

**Vérification (tests `missions-verify E.1` + `E.2`)**
- E.1 : mission expirée d'abord (via `expireIfStillProposed`) → accept ensuite renvoie `409 MISSION_INVALID_STATE` + `reason: 'mission_expired'`. État final = `EXPIRED`, **0 event ACCEPTED**, `prestataireId=NULL`.
- E.2 : `listingExpiresAt = now + 5s`, accept arrive **avant** expiration → 200 + ACCEPTED. Tentative d'expiration arrivée **après** → no-op (`expired: false`), état reste `ACCEPTED`.

✅ **Pas de double terminal, pas de fenêtre de course exploitable.**

---

## 4. Corrections Verify appliquées (sans nouvelle feature)

| # | Fichier | Correction | Justification |
|---|---------|------------|---------------|
| 1 | `domain/mission-event.types.ts` | Étend `FORBIDDEN_KEYS` → email/phone/token/jwt/password (renommée `assertEventPayloadHygiene`, alias gardé) | Audit D élargi (PII + secrets) |
| 2 | `missions.service.ts` `accept()` | Distingue post-race : `ACCEPTED → MissionAlreadyAcceptedError`, `CANCELLED → mission_cancelled`, `EXPIRED → mission_expired`, `PUBLISHED → MissionNotEligibleError` | Audit B + E : reason précis attendu côté client, plus de message trompeur |
| 3 | `missions.service.ts` `toInvalidStateError()` | Mappe `from` → `reason` sémantique stable (`mission_cancelled` / `mission_expired` / `mission_already_accepted`) | Stabilité contrat API pour i18n front |
| 4 | `common/filters/all-exceptions.filter.ts` | Le filter propage maintenant les détails métier (ex: `reason`) du body de l'exception sans écraser la forme principale | Permettre au client de lire `reason` dans le body 409 |

**Aucun de ces changements n'introduit de feature** : ce sont des durcissements/clarifications du périmètre Build déjà mergeable.

---

## 5. Vérifications complémentaires CTO

### 5.1 — Swagger (`/api-docs`)

Vérification statique :
- `apps/api/src/main.ts` configure `SwaggerModule.setup('api-docs', …)` en non-prod avec `addBearerAuth({…}, 'access-jwt')`.
- Annotations confirmées sur `MissionsController` :
  - `@ApiTags('missions')`, `@ApiBearerAuth('access-jwt')` au niveau classe.
  - `@ApiOperation({ summary })` + `@ApiResponse` (status, type, description) sur **les 7 endpoints** : `POST /missions`, `POST /missions/:id/publish`, `DELETE /missions/:id`, `GET /missions/mine`, `GET /missions/proposed`, `POST /missions/:id/accept`, `GET /missions/:id`.
  - DTOs typés `createZodDto` (intégration `nestjs-zod`).
- `AdminMissionsController` : `@ApiTags('admin-missions')` + `@ApiBearerAuth` + `GET /admin/missions`.

Vérification visuelle attendue (CTO) : `pnpm --filter @cc/api dev` → http://localhost:3000/api-docs → tags `missions` + `admin-missions` listés avec body schemas, codes 4xx documentés (`MISSION_NOT_FOUND`, `MISSION_FORBIDDEN`, `MISSION_INVALID_STATE`, `MISSION_ALREADY_ACCEPTED`, `MISSION_NOT_ELIGIBLE`).

✅ **Conf Swagger valide — annotations complètes.**

### 5.2 — RBAC complet

Tests intégration couvrant l'ensemble de la matrice :

| Route | CLIENT prop. | CLIENT autre | PRESTATAIRE éligible | PRESTATAIRE non éligible | ADMIN | Sans token |
|-------|:-:|:-:|:-:|:-:|:-:|:-:|
| `POST /missions` | ✅ 201 | — | ❌ 403 (RolesGuard) | ❌ 403 | ❌ 403 | ❌ 401 |
| `POST /missions/:id/publish` | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 401 |
| `DELETE /missions/:id` | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 401 |
| `POST /missions/:id/accept` | ❌ 403 | ❌ 403 | ✅ 200 | ❌ 403 (NOT_ELIGIBLE) | ❌ 403 | ❌ 401 (Verify) |
| `GET /missions/:id` | ✅ FULL | ❌ 403 | ✅ MASKED | ❌ 403 | ✅ FULL | ❌ 401 (Verify) |
| `GET /admin/missions` | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ✅ 200 (FULL) | ❌ 401 |

Couverture validée par `missions-flow.integration.spec.ts` (tests 8/9/10) + `missions-verify.integration.spec.ts` (RBAC complémentaire 401 sans token + 403 ADMIN refusé pour CLIENT).

✅ **Aucune route sans guard, aucune élévation possible.**

### 5.3 — Logs sans fuite (Pino redactor)

Inspection manuelle des logs intégration (`agent-tools/02dbdfbc-…`) :
- Headers `authorization: [REDACTED]` (preuve sur 50+ requêtes).
- Aucun `street`, `lat`, `lng`, `email`, `passwordHash`, `tokenHash` n'apparaît dans le moindre log de request/response, même pour les routes ADMIN.
- Logs structurés JSON avec `event` propre (`mission.accepted`, `mission.expired`, `mission.matching.failure`).
- `GeocoderService` : sur retry BAN, log `{ event: 'geocoder.ban.failure', attempt, zipCode, err }` — **zipCode acceptable** (5 chiffres, info publique), pas de `street`.

✅ **Pas de fuite PII observée dans les runs intégration.**

### 5.4 — Idempotence d'autres mutations

| Mutation | Garde |
|----------|-------|
| Création mission (POST /missions) | Pas d'idempotence métier (le client est responsable de ne pas re-soumettre) — **acceptable MVP, reportable v2 via `Idempotency-Key` header**. |
| `missionNumber` | UNIQUE en DB + retry service (`MissionNumberService`, max 5 collisions). |
| Publication | `WHERE status='DRAFT'` ⇒ une seule publication par mission. |
| Annulation | `WHERE status IN ('DRAFT','PUBLISHED')` ⇒ une seule annulation. |
| Acceptation | `WHERE status='PUBLISHED' AND prestataireId IN proposals` (lock optimiste). |
| Expiration | `WHERE status='PUBLISHED' AND listingExpiresAt <= now`. |
| Webhooks Stripe | Hors-scope PRD-002 (PRD-003). |

✅ **Toutes les transitions sont conditionnelles et idempotentes au niveau DB.**

---

## 6. Résultats CI / Tests

### Local (validation pré-merge)
- `pnpm typecheck` — **9/9 OK**
- `pnpm lint` — **0 warning, 0 error**
- `pnpm --filter @cc/api test` — **63 tests verts** (46 Build + 17 nouveaux Verify §D)
- `pnpm --filter @cc/api run test:integration` — **51 tests verts**, dont :
  - `auth-flow.integration.spec.ts` — 16 tests (PRD-001)
  - `auth-rate-limit.integration.spec.ts` — 1 test (PRD-001)
  - `missions-flow.integration.spec.ts` — 13 tests (PRD-002 Build)
  - `missions-verify.integration.spec.ts` — **21 tests (PRD-002 Verify, ce rapport)**

### CI GitHub
- **À vérifier après push final** : jobs `quality`, `integration`, `docker-build` doivent rester verts (preuve dans la check suite de la PR #4).

---

## 7. Dettes connues (acceptées CTO Build, inchangées Verify)

| ID | Description | Impact sécu | Plan |
|----|-------------|-------------|------|
| `debt-matching-async-queue` | Matching synchrone dans `publish()`, échec ⇒ mission reste PUBLISHED sans propositions. | Faible (re-publication possible, pas de fuite). | BullMQ producer — sprint 3+. |
| `debt-listing-expiration-queue` | Expiration callable via service mais pas de cron/worker. | Aucun (mission EXPIRED sécurise toute lecture/accept). | Cron 1×/min sur `expireIfStillProposed` — sprint 3+. |
| `debt-mission-distance-display` | `approximateDistanceKm = 0` dans `MaskedMissionAddress`. | Aucun (UX uniquement). | Calcul lat/lng prestataire ⇄ mission — sprint UI mobile. |
| `debt-coverage-report` | Pas de seuil coverage en CI. | Aucun (couverture observée bonne). | `--coverageThreshold` à activer post-MVP. |

Aucune nouvelle dette introduite pendant Verify.

---

## 8. Décision finale

### Conclusion

✅ **APPROVED — merge PR #4 autorisé.**

- Les 5 audits CTO obligatoires (A → E) sont **tous passants**, validés par 21 tests d'intégration dédiés (en plus des 13 tests Build).
- Les 2 corrections Verify (audit B/E reason précis + audit D extension PII/secrets) **n'introduisent aucune feature** et durcissent le périmètre déjà livré.
- RBAC complet, logs propres, Swagger documenté, redactor PII actif, race conditions exploitées sont toutes neutralisées par UPDATE conditionnels Postgres.
- Aucune dette bloquante MVP, dettes acceptées documentées.

### Recommandation

**Merger PR #4 dans `main`** (squash merge, suppression branche `feat/prd-002-missions-build`), puis :
- Tag optionnel : `v0.2.0-missions-foundation`.
- Mettre à jour PRD-002 §6 (Verify done) + `docs/prd/README.md` (status → `RELEASED`).
- Sprint 3 → **PRD-003** : Photos AVANT/APRÈS + Stripe Connect (escrow + auto-release T+48h).

---

*Rapport généré pour validation BMAD-light Verify — Sprint 2.*
