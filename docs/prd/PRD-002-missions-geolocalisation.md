# PRD-002 — Missions & Géolocalisation

> **PRD** = *Product Requirements Document*
> Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) §5 (PostGIS), §2 (Stratégie Mobile App Unique), §11 (Critères MVP), §12 (Risques).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).
> Dépend de [PRD-001 Auth JWT](PRD-001-auth-jwt.md) — `DONE` ✅.

> **Statut** : **Discover validé** + **Design validé** (CTO 2026-05-12) + **Build livré** (Ticket 2.2 — Sprint 2). **En attente Verify + validation CTO finale** avant merge.

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-002` |
| **Slug** | `missions-geolocalisation` |
| **Titre** | Missions & Géolocalisation — modèle, machine d'état, matching PostGIS, créneau, acceptation |
| **Version PRD** | `0.3` (Build Ticket 2.2) |
| **Statut** | `BUILD_REVIEW` (en attente Verify + sign-off CTO) |
| **Owner produit** | CTO Clean Connect |
| **Owner technique** | `senior-dev` + `architecte-api` (BE) + `mobile` (FE) |
| **Persona pilote** | `senior-dev` (Discover) → `architecte-api` (Design BE) → `mobile` (Design FE) |
| **Créé le** | 2026-05-12 |
| **Mis à jour le** | 2026-05-12 |
| **Cible de release** | MVP (Sprint 2) |
| **T-shirt size** | **L** (Mission entity + state machine + matching + géoloc + créneaux ≈ 3–4 semaines) |
| **Lien Cahier v1.4** | §5 PostGIS, §2 RoleGuard mobile, §11 critères MVP (PostGIS indexé), §12 risques (concurrence acceptation, switch rôle) |

---

## 1. Contexte & problème

### 1.1 Pourquoi cette feature ?

Sans modèle **Mission** ni **matching géographique**, aucune valeur produit ne peut être créée :
- un client ne peut pas demander un nettoyage ;
- un prestataire ne peut pas voir ce qui est disponible autour de lui ;
- la plateforme n'a pas d'objet métier sur lequel attacher paiement (PRD-003), photos (PRD-004), notifications (PRD-005), litiges (PRD-006).

Le **Sprint 2** crée donc la **colonne vertébrale produit** : le cycle de vie d'une mission, de sa création par un client jusqu'à son acceptation par un prestataire (les phases « réalisation », « validation client », « paiement », « litige » dépendent de Sprint 3+ — placeholders documentés ici, **non implémentés**).

Sans PRD-002 mergé, PRD-003/004/005/006 sont bloqués (règle dure CTO).

### 1.2 Personas concernés

- [x] **Client** — crée une mission, choisit créneau, voit le prestataire matché, paie (paiement = PRD-003)
- [x] **Prestataire** — voit les missions éligibles dans sa zone, accepte / refuse, organise sa journée
- [x] **Admin** — lecture seule MVP : tableau des missions par statut + recherche par ID (CRUD complet = PRD-007)
- [ ] Système (job, cron, webhook) — *partiellement concerné* : expiration liste (`PROPOSED` → `EXPIRED`) côté BullMQ, cron de sécurité (cf. cahier §6) — détail en Design

### 1.3 Métriques de succès

| Métrique | Baseline | Cible MVP | Comment mesurer |
|---|---|---|---|
| Temps de matching (création → 1ᵉʳ prestataire notifié) | N/A | **p95 < 5 s** | event `mission.matched` − `mission.created` |
| Taux d'acceptation d'une mission proposée | N/A | **≥ 50 %** sous 30 min | `mission.accepted` / `mission.proposed` |
| Couverture tests `MatchingService` | 0 | **≥ 80 %** (cahier v1.4 §11) | jest coverage |
| Index PostGIS effectif | N/A | `EXPLAIN ANALYZE` montre `Index Scan` (pas `Seq Scan`) | requête `ST_DWithin` sur seed 1000 prestataires |
| Latence `POST /missions` (création) | N/A | **p95 < 400 ms** (hors géocodage externe) | logs structurés |

### 1.4 Out of scope (placeholders pour PRDs aval, **non implémentés** ici)

- ❌ Paiement / `PaymentIntent` Stripe / séquestre → **PRD-003**
- ❌ Photos AVANT/APRÈS Cloudinary → **PRD-004**
- ❌ Notifications FCM/email réelles → **PRD-005** (on émet des **events BullMQ** dans PRD-002, sans handler de notif final)
- ❌ Disputes / litiges → **PRD-006**
- ❌ Dashboard admin CRUD complet → **PRD-007** (lecture seule MVP ici)
- ❌ Chat in-app client ↔ prestataire — V2+ (cahier §13)
- ❌ Annulation client avec remboursement automatique — dépend de PRD-003
- ❌ Mode hors-ligne client — V2+ (cahier §13)
- ❌ Avis / rating post-mission — non MVP cadré (à arbitrer plus tard)

---

## 2. User stories & critères d'acceptance

### 2.1 Story 1 — Création de mission par un client

**En tant que** client authentifié
**Je veux** créer une mission (type de prestation, adresse, créneau préféré, surface estimée)
**Pour** que la plateforme trouve un prestataire proche de moi

**Critères d'acceptance** :
- [ ] **AC-1.1** — Étant donné un client connecté (`role=CLIENT`), quand il `POST /api/v1/missions` avec un body valide (type, adresse géocodée, fenêtre de créneau, surface), alors la mission est créée en statut `BROUILLON` (cf. §2.1bis machine d'état) avec un UUID et `clientId` lié.
- [ ] **AC-1.2** — Étant donné une mission en `BROUILLON`, quand le client appelle `POST /api/v1/missions/:id/publish`, alors la mission passe en `PUBLIEE`, déclenche le **matching** (event BullMQ), et est immuable sur les champs structurants (adresse, type, créneau).
- [ ] **AC-1.3** — Un prestataire (`role=PRESTATAIRE`) qui appelle `POST /missions` reçoit **`403`** (RoleGuard).
- [ ] **AC-1.4** — Une adresse sans coordonnées GPS (échec géocodage) renvoie **`422 GEOCODING_FAILED`** (pas 500).
- [ ] **AC-1.5** — Surface négative, type inconnu, créneau dans le passé → **`400 ValidationError`** Zod.

**Cas d'erreur** :
- [ ] Body sans `type` → 400
- [ ] Créneau `endAt < startAt` → 400
- [ ] Token expiré → 401
- [ ] Code postal hors France → 422 ou 400 (à arbitrer Q3.3)

### 2.1bis Machine d'état — scope MVP PRD-002

> **Lexique** : les AC rédigés en français utilisent les noms « métier » ; l’implémentation utilise les enums **anglais** Prisma / `@cc/shared-types` :
>
> | FR (PRD) | Enum |
> |---|---|
> | BROUILLON | `DRAFT` |
> | PUBLIEE | `PUBLISHED` |
> | PROPOSEE | `PROPOSED` |
> | ACCEPTEE | `ACCEPTED` |
> | ANNULEE | `CANCELLED` |
> | EXPIREE | `EXPIRED` |

```
[DRAFT] ──publish──> [PUBLISHED] ──matching OK──> [PROPOSED] ──accept (prestataire)──> [ACCEPTED]
     │                       │                          │                                       │
     │                       │                          │                                       │
     │                  cancel client                cancel (timeout 15 min liste — cf. Q5)     │  (cycle "réalisation/validation/paiement"
     │                       ▼                          ▼                                       │   = PRD-003/004 — placeholders)
     │                  [CANCELLED]                  [EXPIRED]                                    │
     │                                                                                          │
     └──── delete (soft) ─────────────────────────────────────────────────────────────────────  │
                                                                                                │
                                                                                  (transitions terminales scope MVP)
```

> 🔵 **Scope strict PRD-002** : `DRAFT / PUBLISHED / PROPOSED / ACCEPTED / CANCELLED / EXPIRED`. Les états `IN_PROGRESS / AWAITING_CLIENT_VALIDATION / COMPLETED / DISPUTE_OPEN / REFUNDED` sont **modélisés** (enum Prisma figé) mais **aucune transition MVP** ne les atteint — placeholders PRD-003/004/006.

### 2.2 Story 2 — Matching géographique automatique

**En tant que** système
**Je veux** identifier les prestataires éligibles (rôle, zone d'intervention, type accepté, disponibilité du créneau) dans un rayon configurable
**Pour** proposer la mission à chacun (ou au plus proche — cf. Q3.4)

**Critères d'acceptance** :
- [ ] **AC-2.1** — Étant donné une mission en `PUBLISHED`, quand le job BullMQ `mission.matching` s'exécute, alors `MatchingService` retourne la liste des prestataires `ST_DWithin(prestataire.address.location, mission.address.location, prestataire.serviceRadiusKm * 1000)`, triés par distance ASC, **`LIMIT 50`**.
- [ ] **AC-2.2** — L'`EXPLAIN ANALYZE` de la requête montre `Index Scan` sur `addresses_location_gist` (GIST), pas `Seq Scan` (cahier §11).
- [ ] **AC-2.3** — Un prestataire sans `location` ou `deletedAt != null` est exclu.
- [ ] **AC-2.4** — Un prestataire dont la zone d'intervention (km) **n'inclut pas** le point de la mission est exclu (même s'il est physiquement proche).
- [ ] **AC-2.5** — Si **0 prestataire éligible**, la mission passe en `EXPIREE` après timeout (cf. Q3.4 timeout), pas de crash, log structuré `mission.matching.no_candidate`.
- [ ] **AC-2.6** — La requête PostGIS est encapsulée dans un `$queryRaw` typé `EligiblePrestataire[]` avec commentaire justifiant le raw (cahier §5).

### 2.3 Story 3 — Acceptation par un prestataire (avec lock anti-concurrence)

**En tant que** prestataire authentifié
**Je veux** voir les missions proposées et en accepter une
**Pour** organiser ma journée et gagner de l'argent

**Critères d'acceptance** :
- [ ] **AC-3.1** — Étant donné une mission en `PROPOSEE` avec ce prestataire dans la liste matchée, quand il appelle `POST /api/v1/missions/:id/accept`, alors la mission passe en `ACCEPTEE` avec `assignedPrestataireId` figé.
- [ ] **AC-3.2** — Lock optimiste : 2 prestataires acceptant **simultanément** → un seul gagne (`200 ACCEPTEE`), l'autre reçoit `409 MISSION_ALREADY_ACCEPTED`. Cf. cahier §12 risque « Concurrence acceptation mission ».
- [ ] **AC-3.3** — Un prestataire qui n'est pas dans la liste matchée (ou qui a `deletedAt != null`) → `403 NOT_ELIGIBLE`.
- [ ] **AC-3.4** — Une mission déjà `ACCEPTEE / ANNULEE / EXPIREE` → `409 MISSION_NOT_PROPOSABLE` avec `error.state` indiqué.
- [ ] **AC-3.5** — Un client tentant `/accept` → `403`.

**Cas d'erreur** :
- [ ] Mission inexistante → 404
- [ ] Token expiré → 401
- [ ] Race condition exactement simultanée (transaction + `WHERE assignedPrestataireId IS NULL`) → 1 gagnant garanti.

### 2.4 Story 4 — Lecture des missions selon le rôle (RBAC + ownership)

**En tant que** client OU prestataire
**Je veux** lister mes missions
**Pour** suivre l'état d'avancement

**Critères d'acceptance** :
- [ ] **AC-4.1** — Un client (`role=CLIENT`) appelant `GET /api/v1/missions` reçoit **uniquement** les missions où `clientId = me.id`, paginées (`?cursor=<id>&take=20`).
- [ ] **AC-4.2** — Un prestataire (`role=PRESTATAIRE`) appelant `GET /api/v1/missions/proposed` reçoit **uniquement** les missions en `PROPOSEE` où il fait partie des matchés ; `GET /api/v1/missions` retourne les missions où il est `assignedPrestataireId`.
- [ ] **AC-4.3** — `GET /api/v1/missions/:id` :
  - 200 si client owner OU prestataire matché/assigné OU admin
  - 403 sinon
  - 404 si inconnu (pas de leak d'existence pour les utilisateurs non concernés — code `404` au lieu de 403 quand le caller n'a aucun lien).
- [ ] **AC-4.4** — **Visibilité de l'adresse** : avant acceptation, le prestataire ne voit que la **ville + code postal** (cf. Q3.6 RGPD/no-show) ; après acceptation, il voit l'adresse complète.

### 2.5 Story 5 — Annulation par le client

**En tant que** client
**Je veux** annuler ma mission tant qu'elle n'est pas acceptée
**Pour** revenir sur ma décision sans frais

**Critères d'acceptance** :
- [ ] **AC-5.1** — Étant donné une mission en `BROUILLON / PUBLIEE / PROPOSEE`, quand le client appelle `DELETE /api/v1/missions/:id`, alors la mission passe en `ANNULEE` (soft, pas de DELETE SQL). Idempotent.
- [ ] **AC-5.2** — Une mission `ACCEPTEE / *` ne peut **pas** être annulée par cette route → `409 NOT_CANCELLABLE_AT_THIS_STAGE` (l'annulation après acceptation = PRD-003 avec gestion financière).

---

## 3. Phase DISCOVER

### 3.1 Risk assessment (1 = faible, 5 = critique)

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| **Sécurité (RBAC + ownership)** | **4** | RoleGuard à étendre, ownership check sur 5+ endpoints, visibilité conditionnelle de l'adresse (Story 4.4). | Pré-revue `reviewer-securite-code` obligatoire en Design + audit complet en Verify (focus `missions.controller`). |
| **RGPD (adresse, géoloc)** | **4** | Coordonnées GPS + adresse client = données personnelles ; minimisation Article 5 RGPD (ne pas exposer l'adresse précise avant acceptation). | Lecture par référent RGPD ; documenter la rétention (cf. cahier 12 mois après fin de mission, mais ici scope = avant exécution donc rétention via PRD-004). |
| **Financier** | 2 | Aucun paiement dans PRD-002. Enum `AWAITING_CLIENT_VALIDATION` réservé PRD-003. | — |
| **UX (régression)** | **4** | Le matching = parcours principal MVP. Une latence > 5 s ou un faux 0 prestataire tuent l'expérience. | Detox happy path obligatoire (cahier §11) + plan de charge sur `MatchingService`. |
| **Performance** | **3** | `ST_DWithin` sur potentiellement N prestataires. Sans index GIST = catastrophe. | EXPLAIN ANALYZE en Verify ; benchmark sur seed 1k prestataires. |
| **Disponibilité externe** | **3** | Géocodage adresse → coords via service externe (Nominatim / Google / Mapbox — cf. Q3.3). Service down = création mission impossible. | Pattern *integrate-external-service* obligatoire (timeout + retry + fallback), DLQ si géocodage échoue. |

→ 3 domaines à **4** → **pré-revue sécu Design obligatoire** + audit complet Verify.

### 3.2 Modules touchés

- [x] `apps/api/src/modules/missions/` *(nouveau)* — controller, service, repository, machine d'état
- [x] `apps/api/src/modules/matching/` *(nouveau)* — `MatchingService` (`$queryRaw` PostGIS), repository, processor BullMQ `mission.matching`
- [x] `apps/api/src/modules/users/` *(extension)* — endpoints prestataire `PATCH /users/me/location`, `PATCH /users/me/zone-intervention`
- [x] `apps/api/src/modules/admin/` *(nouveau, lecture seule MVP)* — `GET /admin/missions?status=...&cursor=...`
- [x] `apps/mobile/src/features/missions/` *(nouveau)* — création mission, recherche d'adresse, liste missions, écran détail
- [x] `apps/mobile/src/features/matching/` *(nouveau ou intégré à missions)* — écran prestataire « missions proposées »
- [x] `packages/shared-types/src/zod/` *(extension)* — `mission.ts`, `matching.ts`, types géo (`geoPointSchema` existe déjà)
- [x] `apps/api/prisma/schema.prisma` *(modification structurante)* — `Mission`, `MissionProposal`, enums `MissionStatus` / `MissionServiceType`, `users.service_radius_km` ; matching via `addresses.location` (GIST — ADR-003)
- [x] BullMQ — files `mission.matching`, `mission.listing_expired` + DLQ + cron (cahier §6)
- [x] Configuration / infra — `MISSION_LISTING_TTL_MS` (défaut 15 min, Build) ; BAN sans clé API

### 3.3 Open questions — **RÉSOLUES** (Discover CTO 2026-05-12)

> Les décisions ci-dessous reprennent le **bloc détaillé** validé par le CTO. Un second tableau contradictoire dans le même message a été **écarté** au profit de ce cadrage.

| # | Décision |
|---|----------|
| **Q1** | Fenêtre obligatoire : `startAt`, `endAt`, `timeZone` (IANA). `isAsap=true` → **conversion en fenêtre côté serveur** à la publication. |
| **Q2** | Enum `MissionServiceType` : `SOFA`, `MATTRESS`, `TERRACE`, `TRASH_BINS`, `CARPET`, `OTHER`. |
| **Q3** | **BAN** (`api-adresse.data.gouv.fr`) provider principal ; **repli coordonnées GPS natives mobile** validées côté API. **ADR-006**. |
| **Q4** | **Marketplace first-accepted-wins** ; pas de round-robin MVP. **ADR-005**. |
| **Q5** | Timeout après publication liste : **15 minutes** → job BullMQ delayed `mission.listing_expired` → `EXPIRED`. |
| **Q6** | Adresse masquée pour prestataire avant acceptation : **ville + CP partiel + distance approx km** ; adresse complète seulement après `ACCEPTED` + assignation. Politique : `mission-address.policy.ts`. |
| **Q7** | **Lock optimiste transaction SQL** sur `accept` ; pas de Redis lock MVP. **Détection conflit de créneaux** entre missions acceptées pour un même prestataire : **hors MVP** (dette Build si besoin). |
| **Q8** | Tarification **hors PRD-002** ; seul placeholder `estimatedPriceCents` (`Int?`). **ADR-007**. |
| **Q9** | `serviceRadiusKm` sur `users` : **défaut 15 km**, **max 30 km** (contrainte SQL + Zod profil). |
| **Q10** | `missionNumber` lisible unique `CC-2026-000123` ; UUID reste PK. Génération atomique **Build** (séquence / transaction). |

### 3.4 Definition of Done — Discover

- [x] PRD instancié avec ID, slug, statut `DRAFT`
- [x] Lien explicite vers section du cahier v1.4 (§5 PostGIS, §11 critères MVP)
- [x] ≥ 1 user story avec critères d'acceptance testables (5 stories, 30+ critères AC)
- [x] Risk assessment renseigné (3 domaines à 4 → pré-revue sécu requise)
- [x] Métriques de succès quantifiables (p95 matching, taux acceptation, couverture, perf PostGIS)
- [x] Out of scope listé (paiement, photos, notifs, disputes, admin CRUD)
- [x] **Open questions toutes résolues** (`RESOLVED`)
- [x] T-shirt size estimé (**L**, ≈ 3–4 semaines)
- [x] **Validation humaine CTO Discover** — 2026-05-12

> ✍️ Discover **validé** — Design Ticket **2.1** livré en `DESIGN_REVIEW` (sign-off CTO Design requis avant Build).

---

## 4. Phase DESIGN (Ticket 2.1 — livré, `DESIGN_REVIEW`)

> **Contraintes CTO** : machine d'état centralisée typée ; enum unique `@cc/shared-types` ↔ Prisma ; transitions impossibles hors `mission-state.machine.ts` ; visibilité adresse via `mission-address.policy.ts` ; géométrie métier PostGIS ; extensibilité enums futurs ; zéro logique métier dans controllers ; pré-revue sécu obligatoire avant Build ; **aucun Build** sans sign-off humain Design.

### 4.1 Schéma DB (Prisma)

- Fichiers : `apps/api/prisma/schema.prisma`, migration `20260512190000_prd002_mission_lifecycle_design/migration.sql`.
- **`Mission`** : `missionNumber` unique, `status`, `serviceType`, acteurs, `addressId`, fenêtre `startAt`/`endAt`, `timeZone`, `isAsap`, `estimatedPriceCents?`, `publishedAt?`, `listingExpiresAt?`, `stripePaymentIntentId?` (PRD-003).
- **`MissionProposal`** : `(missionId, prestataireId)` unique — éligibles matching.
- **`User.serviceRadiusKm`** : défaut **15**, max **30** (CHECK SQL).
- **PostGIS** : coords sur `addresses.location` + index GIST existant ; matching `ST_DWithin` entre adresse mission et adresse base prestataire, rayon `service_radius_km * 1000` m (**Build**).
- Migration **destructrice** pré-prod : truncate `photos` + `missions` — documentée en SQL.

### 4.2 Schémas Zod (`packages/shared-types`)

| Fichier | Rôle |
|---|---|
| `zod/enums.ts` | `MissionStatusSchema`, `MissionServiceTypeSchema` (alignés Prisma) |
| `zod/mission.ts` | `createMissionDraftBodySchema`, DTOs adresse masquée / `eligiblePrestataireSchema` |

### 4.3 Contrat API (spec — impl. Build)

| Méthode | Route | Auth |
|---|---|---|
| `POST` | `/api/v1/missions` | JWT `CLIENT` |
| `POST` | `/api/v1/missions/:id/publish` | JWT owner |
| `POST` | `/api/v1/missions/:id/accept` | JWT `PRESTATAIRE` |
| `GET` | `/api/v1/missions` | JWT (liste selon rôle) |
| `GET` | `/api/v1/missions/proposed` | JWT `PRESTATAIRE` |
| `GET` | `/api/v1/missions/:id` | JWT |
| `DELETE` | `/api/v1/missions/:id` | JWT owner |
| `GET` | `/api/v1/admin/missions` | JWT `ADMIN` |

### 4.4 Contrat UI

- Client : création (RHF + Zod `@cc/shared-types`), publication, liste.
- Prestataire : proposées, détail (adresse masquée), acceptation.
- Admin : liste lecture seule + recherche `missionNumber` / UUID.

### 4.5 Jobs BullMQ

- `mission.matching` (post-publish) ; `mission.listing_expired` (delay **15 min**) ; cron filet (cahier §6) — détail impl. Build.

### 4.6 ADR

- [`ADR-005`](../adr/ADR-005-missions-matching-marketplace.md), [`ADR-006`](../adr/ADR-006-geocoding-ban-mobile-fallback.md), [`ADR-007`](../adr/ADR-007-mission-pricing-placeholder.md).

### 4.7 Plan de tests

- Unit : `mission-state.machine`, `mission-address.policy`, `MatchingService` (≥80 % cible).
- Intégration : création, publish, accept race, expire.
- E2E Detox ; audit sécu Verify.

### 4.8 Rollout

- Feature flag `FF_MISSIONS` recommandé ; `MISSION_LISTING_TTL_MS` défaut `900000` au Build.

### 4.9 Definition of Done — Design

- [x] Prisma + migration + Zod + domaine typé + tests unitaires domaine
- [x] Contrats API / UI / jobs documentés
- [x] ADR-005/006/007 + pré-revue [`2026-05-12-prd-002-missions-design-prereview.md`](../security-reviews/2026-05-12-prd-002-missions-design-prereview.md)
- [x] **Sign-off CTO Design** — 2026-05-12 ✅

---

## 5. Phase BUILD (Ticket 2.2 — livré)

> **Contraintes CTO Build appliquées** (validation 2026-05-12) :
> §1 `MissionEvent { missionId, type, actorUserId, payload, createdAt }` audit minimal — §2 `missionNumber` immuable serveur-only — §3 matching PostGIS paginé + borné — §4 aucune adresse complète logs/push/queue/erreurs pré-acceptation — §5 exclusion suspendus / soft-deleted / non vérifiés — §6 toute transition via `assertMissionTransition()` — §7 zéro logique métier dans les controllers.

### 5.1 Schéma DB (additif Build)

- Migration `20260512200000_prd002_mission_events_user_status/migration.sql` (additive, non destructive) :
  - `users.verified_at TIMESTAMPTZ DEFAULT NOW()` — null ⇒ exclusion matching (§5)
  - `users.suspended_at TIMESTAMPTZ NULL` — non null ⇒ exclusion matching (§5)
  - `mission_events` : `id (uuid)`, `mission_id`, `type VARCHAR(64)`, `actor_user_id?`, `payload JSONB?`, `created_at` ; index `(mission_id, created_at)` + `(type)`.
- `MissionStatus` complet (DRAFT, PUBLISHED, ACCEPTED, EXPIRED, CANCELLED + placeholders aval) — états aval inertes (aucune transition).

### 5.2 Modules / fichiers livrés

| Couche | Fichiers (clé) |
|---|---|
| Domaine pur | `mission-state.machine.ts` (transitions strictes), `mission-address.policy.ts` (masquage RGPD), `mission-event.types.ts` (`assertNoAddressLeak`) |
| Repository | `missions.repository.ts` — CRUD + matching `$queryRaw` PostGIS + lock optimiste UPDATE conditionnel |
| Services | `MissionsService`, `MissionNumberService`, `MissionEventService`, `GeocoderService` (BAN + GPS fallback, retry/timeout), `MatchingService`, `MissionViewService` |
| HTTP | `MissionsController` (CLIENT/PRESTATAIRE) + `AdminMissionsController` (ADMIN) — DTOs `nestjs-zod` ; aucune logique métier |
| Erreurs | `missions.errors.ts` — codes stables `MISSION_NOT_FOUND / FORBIDDEN / INVALID_STATE / ALREADY_ACCEPTED / NOT_ELIGIBLE / GEOCODING_FAILED / VALIDATION_FAILED` |

### 5.3 Endpoints livrés

| Méthode | Route | Auth | Rôle |
|---|---|---|---|
| `POST` | `/api/v1/missions` | Bearer JWT | `CLIENT` |
| `POST` | `/api/v1/missions/:id/publish` | Bearer JWT | `CLIENT` (owner) |
| `POST` | `/api/v1/missions/:id/accept` | Bearer JWT | `PRESTATAIRE` |
| `DELETE` | `/api/v1/missions/:id` | Bearer JWT | `CLIENT` (owner) |
| `GET` | `/api/v1/missions/mine` | Bearer JWT | `CLIENT` |
| `GET` | `/api/v1/missions/proposed` | Bearer JWT | `PRESTATAIRE` |
| `GET` | `/api/v1/missions/:id` | Bearer JWT | `CLIENT` / `PRESTATAIRE` / `ADMIN` (RBAC service) |
| `GET` | `/api/v1/admin/missions` | Bearer JWT | `ADMIN` |

### 5.4 Sécurité — garde-fous appliqués

- Pino redactor étendu : `req.body.address.street`, `req.body.address.location`, `*.street`, `*.location.lat/lng`.
- `MissionEventService` refuse tout payload audit contenant `street/lat/lng/location/...` (`assertNoAddressLeak` récursif).
- `MatchingService` ne reçoit jamais d'adresse en mémoire (PostGIS travaille sur `addresses.location` côté DB) ; le payload audit `MATCHING_DONE` ne contient que `matchedCount / proposalsCreated / maxProviders`.
- `GET /missions/:id` : prestataire non assigné voit `address.kind = "MASKED"` (`partialZipCode = "75***"`, pas de `street`, pas de `lat/lng`).
- `accept` lock optimiste **dans la même `UPDATE`** : `WHERE status='PUBLISHED' AND listingExpiresAt > now AND proposals.some(prestataireId=...)` ; race entre 2 prestataires → 1 winner (200) / 1 perdant (409 `MISSION_ALREADY_ACCEPTED`).
- `missionNumber` immuable : généré par `MissionNumberService` (CC-YYYY-XXXXXXXX, base36 6 octets random) ; jamais modifié post-création.

### 5.5 Tests

- **Unit (46 verts)** :
  - `mission-state.machine.spec.ts` (transitions + cas négatifs `PUBLISHED→ACCEPTED`)
  - `mission-address.policy.spec.ts` (masquage CP partiel)
  - `mission-event.types.spec.ts` (rejets `street/lat/lng/location`)
  - `mission-number.service.spec.ts` (format + 1000 tirages distincts)
  - `geocoder.service.spec.ts` (court-circuit GPS, parse BAN, retry → throw)
- **Integration (33 verts, dont 13 missions)** :
  - flow nominal CREATE → PUBLISH → matching → ACCEPT
  - matching exclusions : suspendu / non vérifié / soft-deleted / hors rayon
  - masquage adresse pré-acceptation (`MASKED` → `FULL` post-ACCEPT)
  - **race accept first-wins** : `[200, 409]` garantis
  - RBAC : autre CLIENT → 403 ; PRESTATAIRE sur POST → 403 ; ADMIN voit `FULL`
  - state machine : publish post-CANCEL → 409 `MISSION_INVALID_STATE`
  - listing expiration : `expireIfStillProposed` après backdate → `EXPIRED` + `MissionEvent.EXPIRED`
  - Validation Zod : `endAt < startAt` → 400 `ValidationError`

### 5.6 Dettes acceptées (documentées)

- `debt-matching-async-queue` — matching exécuté **synchroneously** dans `publish()` au lieu d'un job BullMQ producer/consumer. Acceptable MVP (latence p95 mesurée < 100 ms en local) ; à basculer si volume > 100 missions/min.
- `debt-listing-expiration-queue` — `expireIfStillProposed()` est invocable mais **non branché** sur un job BullMQ delayed ni un cron. À ajouter avant ouverture de la marketplace publique (Verify ou Sprint 2.5). Workaround : appel manuel admin / cron OS / future processor BullMQ.
- `debt-mission-distance-display` — la distance approximative dans `MaskedMissionAddress` est renvoyée à `0` (UI affiche "à proximité"). Calcul réel = future itération (nécessite croisement adresse prestataire viewer ↔ adresse mission).
- `debt-coverage-report` — pas de seuil `coverage >= 80%` enforced en CI. À ajouter en Verify.

### 5.7 Definition of Done — Build

- [x] Toutes les contraintes CTO §1–§7 implémentées et testées.
- [x] `pnpm typecheck` vert (monorepo).
- [x] `pnpm lint` vert (`max-warnings=0`).
- [x] `pnpm --filter @cc/api test` vert (46 tests).
- [x] `pnpm --filter @cc/api run test:integration` vert (33 tests, dont matching PostGIS réel).
- [x] Migrations appliquées sans erreur sur DB de test.
- [x] Pino redactor étendu (`address.street/location`).
- [x] Dettes documentées (§5.6) — aucune dette critique.
- [ ] Audit `reviewer-securite-code` (Verify Sprint 2)
- [ ] Sign-off CTO Build

---

## 6. Phase VERIFY

⛔ À démarrer après sign-off CTO Build (audit sécurité ciblé : RBAC mission, masquage adresse, payload audit, race accept, exclusions matching).

---

## 7. Post-release

TBD

---

## 8. Annexes

### 8.1 Recherches / benchmarks à conduire en Design

- Comparatif géocodage (Q3) : Nominatim vs adresse.data.gouv.fr vs Google Geocoding (quotas, latence, précision).
- Benchmarks `ST_DWithin` sur seed 1k / 10k / 100k prestataires (perf gate cahier §11).
- Pattern lock optimiste vs `SELECT ... FOR UPDATE` pour AC-3.2.

### 8.2 Refusés / alternatives à arbitrer en Design (pré-écrites)

| Alternative | Pourquoi probablement non retenue (à confirmer Design) |
|---|---|
| `GEOMETRY` au lieu de `GEOGRAPHY` | Calcul plan (m²) au lieu de sphérique → erreurs significatives sur la France. Cahier §5 tranche explicitement `GEOGRAPHY`. |
| Matching synchrone HTTP (pas BullMQ) | Création mission bloquante > 1 s en cas de DB lente ; impossible à scaler. Job asynchrone par défaut. |
| Mission avec `address: string` simple (sans coords pré-calculées) | Géocodage à chaque matching = catastrophe perf + dépendance externe sur chaque requête. On précalcule au moment de la création. |

### 8.3 Glossaire

- **Matching** : algorithme qui sélectionne les prestataires éligibles pour une mission donnée (filtres rôle + zone + dispo + type).
- **Zone d'intervention** : rayon en km autour de la base d'un prestataire, dans lequel il accepte des missions.
- **PostGIS GEOGRAPHY(Point, 4326)** : type Postgres pour stocker un point GPS calculé sur la sphère terrestre (WGS84).
- **`ST_DWithin`** : fonction PostGIS « tous les points dans un rayon donné ». Indexable avec GIST.
- **Lock optimiste** : pattern où la mise à jour vérifie une condition (`WHERE assignedPrestataireId IS NULL`) ; un seul write réussit en cas de race.

---

## 9. Checklist BMAD globale

- [x] **Discover** : DoD validée + validation CTO (2026-05-12)
- [x] **Design** : Ticket 2.1 livré + validation CTO (2026-05-12)
- [x] **Build** : Ticket 2.2 livré (Sprint 2) — DoD §5.7 cochée sauf audit reviewer + sign-off CTO
- [ ] **Verify** : à démarrer (audit `reviewer-securite-code` + sign-off CTO final)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-002 v0.3 — Build Ticket 2.2 — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md).*
