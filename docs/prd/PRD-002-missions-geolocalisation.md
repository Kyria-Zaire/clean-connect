# PRD-002 — Missions & Géolocalisation

> **PRD** = *Product Requirements Document*
> Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) §5 (PostGIS), §2 (Stratégie Mobile App Unique), §11 (Critères MVP), §12 (Risques).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).
> Dépend de [PRD-001 Auth JWT](PRD-001-auth-jwt.md) — `DONE` ✅.

> **⚠️ Statut** : Phase **DISCOVER en cours**. Ne pas démarrer le Design tant que les Open Questions §3.3 ne sont pas toutes `RESOLVED` et que la DoD Discover §3.4 n'est pas validée humainement par le CTO.

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-002` |
| **Slug** | `missions-geolocalisation` |
| **Titre** | Missions & Géolocalisation — modèle, machine d'état, matching PostGIS, créneau, acceptation |
| **Version PRD** | `0.1` (Discover initial) |
| **Statut** | `DRAFT` (Discover en cours) |
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
- [ ] Système (job, cron, webhook) — *partiellement concerné* : expiration créneau (`PROPOSE` → `EXPIRED`) côté BullMQ, cron de sécurité (cf. cahier §6) — détail en Design

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

```
[BROUILLON] ──publish──> [PUBLIEE] ──matching OK──> [PROPOSEE] ──accept (prestataire)──> [ACCEPTEE]
     │                       │                          │                                       │
     │                       │                          │                                       │
     │                  cancel client                cancel (timeout 30 min ou refus tous)     │  (cycle "réalisation/validation/paiement"
     │                       ▼                          ▼                                       │   = PRD-003/004 — placeholders)
     │                  [ANNULEE]                  [EXPIREE]                                    │
     │                                                                                          │
     └──── delete (soft) ─────────────────────────────────────────────────────────────────────  │
                                                                                                │
                                                                                  (transitions terminales scope MVP)
```

> 🔵 **Scope strict PRD-002** : `BROUILLON / PUBLIEE / PROPOSEE / ACCEPTEE / ANNULEE / EXPIREE`. Les états `EN_COURS / TERMINEE / EN_ATTENTE_VALIDATION_CLIENT / VALIDEE / LITIGE_OUVERT / REMBOURSEE` sont **modélisés** (enum Prisma figé) mais **aucune transition vers ces états n'est implémentée** dans Sprint 2 — placeholders pour PRD-003/004/006.

### 2.2 Story 2 — Matching géographique automatique

**En tant que** système
**Je veux** identifier les prestataires éligibles (rôle, zone d'intervention, type accepté, disponibilité du créneau) dans un rayon configurable
**Pour** proposer la mission à chacun (ou au plus proche — cf. Q3.4)

**Critères d'acceptance** :
- [ ] **AC-2.1** — Étant donné une mission en `PUBLIEE`, quand le job BullMQ `mission.matching` s'exécute, alors `MatchingService` retourne la liste des prestataires `ST_DWithin(prestataire.location, mission.location, prestataire.zoneInterventionKm * 1000)`, triés par distance ASC, **`LIMIT 50`**.
- [ ] **AC-2.2** — L'`EXPLAIN ANALYZE` de la requête montre `Index Scan` sur `User_location_idx` (GIST), pas `Seq Scan` (cahier §11).
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
| **Financier** | 2 | Aucun paiement dans PRD-002. Placeholder enum `EN_ATTENTE_VALIDATION_CLIENT` figé mais non transactionnel. | — |
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
- [x] `apps/api/prisma/schema.prisma` *(modification structurante)* — modèle `Mission`, enum `MissionStatus`, FK `User.location` GEOGRAPHY + `zoneInterventionKm` (cf. cahier §5)
- [x] BullMQ — file `matching` avec processor + DLQ + cron de sécurité (cahier §6)
- [x] Configuration / infra — variable d'env pour la clé service de géocodage (Q3.3), index GIST sur `Mission.location`

### 3.3 Open questions (à résoudre AVANT Design)

> Toute question non résolue ici bloque le passage en Design. Réponses attendues du CTO.

| # | Question | Owner | Statut | Réponse |
|---|---|---|---|---|
| **Q1** | **Création** : le client précise un **créneau précis** (date + heure début/fin) ou une **fenêtre large** (ex. « vendredi matin 8h-12h ») ? L'app supporte-t-elle « dès que possible » (ASAP) en MVP ? | CTO | `OPEN` | |
| **Q2** | **Type de prestation** : enum fixe (cf. cahier — *fin de chantier / déchet sauvage / résidence saisonnière / autre*) ou champ libre + tag ? Impact sur les schémas Zod + admin filters. | CTO | `OPEN` | |
| **Q3** | **Géocodage** : on utilise quelle source pour transformer une adresse en coordonnées GPS ? Options : (a) **Nominatim OSM** gratuit mais quota strict, (b) **Google Geocoding API** payant, (c) **adresse.data.gouv.fr** (BAN française, gratuit, illimité, **recommandation MVP**), (d) géocodage côté mobile via SDK natif. Cf. cahier §12 risque dispo externe. | CTO | `OPEN` | |
| **Q4** | **Matching** : on propose la mission à **tous** les prestataires éligibles simultanément (premier accepteur gagne, type "marketplace"), ou **séquentiellement** au plus proche d'abord avec timeout (type "round-robin Uber") ? Impact UX prestataire + complexité backend. | CTO | `OPEN` | |
| **Q5** | **Timeout création → expiration** : combien de temps entre `PUBLIEE` et `EXPIREE` si aucun prestataire n'accepte ? **30 min / 1 h / 4 h / 24 h / fonction de la date de prestation ?** | CTO | `OPEN` | |
| **Q6** | **Visibilité adresse avant acceptation** : le prestataire voit **ville + CP** seulement (proposition par défaut, alignée RGPD §3.1), ou **adresse complète + distance précise depuis sa base** ? Impact : risque de no-show (s'il connaît le quartier exact) vs friction (s'il ne le connait pas). | CTO | `OPEN` | |
| **Q7** | **Multi-acceptation** : un prestataire peut-il avoir plusieurs missions `ACCEPTEE` avec des créneaux qui se chevauchent ? On bloque l'acceptation en cas de conflit créneau ? | CTO | `OPEN` | |
| **Q8** | **Tarification** : prix défini par **le client** à la création (« je propose 80 € »), par **un barème serveur** (€/m² × type), ou par **devis prestataire post-matching** ? MVP = quoi ? *Impact : PRD-003 ne peut pas démarrer sans cette décision.* | CTO | `OPEN` | |
| **Q9** | **Zone d'intervention prestataire** : valeur par défaut **30 km** (cahier §5), modifiable par le prestataire dans son profil (à quel endroit en mobile ?). Faut-il une **borne max** (ex. 50 km) pour éviter qu'un prestataire couvre la France entière ? | CTO | `OPEN` | |
| **Q10** | **Mission n° unique métier** : on garde uniquement l'`id` UUID, ou on génère aussi un **numéro court lisible humain** (ex. `CC-2026-04321`) pour les communications support/admin ? | CTO | `OPEN` | |

### 3.4 Definition of Done — Discover

- [x] PRD instancié avec ID, slug, statut `DRAFT`
- [x] Lien explicite vers section du cahier v1.4 (§5 PostGIS, §11 critères MVP)
- [x] ≥ 1 user story avec critères d'acceptance testables (5 stories, 30+ critères AC)
- [x] Risk assessment renseigné (3 domaines à 4 → pré-revue sécu requise)
- [x] Métriques de succès quantifiables (p95 matching, taux acceptation, couverture, perf PostGIS)
- [x] Out of scope listé (paiement, photos, notifs, disputes, admin CRUD)
- [ ] **Open questions toutes résolues** (`RESOLVED`) — **10 questions ouvertes** ⏳
- [x] T-shirt size estimé (**L**, ≈ 3–4 semaines)
- [ ] **Validation humaine** (CTO) : nom + date — **en attente**

> ✍️ *Validation Discover attendue du CTO une fois les Open Questions Q1–Q10 résolues.*

---

## 4. Phase DESIGN

> ⛔ **Bloquée tant que Discover §3.4 n'est pas validé**. Le squelette ci-dessous sera rempli en Ticket 2.2.

### 4.1 Schéma DB (Prisma)
*À remplir en Design — diff `Mission` model + enum `MissionStatus` + index GIST + FK `User.location`.*

### 4.2 Schémas Zod (`packages/shared-types`)
*À remplir — `missionSchema`, `createMissionRequestBodySchema`, `matchedPrestataireSchema`, etc.*

### 4.3 Contrat API
*À remplir — `POST /missions`, `POST /missions/:id/publish`, `POST /missions/:id/accept`, `GET /missions`, `GET /missions/:id`, `DELETE /missions/:id`, `POST /admin/missions/search` (lecture).*

### 4.4 Contrat UI
*À remplir — flux mobile client (création), flux mobile prestataire (proposées), table admin (liste).*

### 4.5 Effets de bord, jobs, webhooks
*À remplir — BullMQ `mission.matching` (création), `mission.expire` (delayed Q5), DLQ, cron horaire.*

### 4.6 ADR liées
*Pré-listées* :
- **ADR-005** — Stratégie de matching (marketplace vs round-robin) — déclenchée par Q4
- **ADR-006** — Source géocodage adresse → coords — déclenchée par Q3
- **ADR-007** — Modèle de tarification (Q8) — déclenchée par Q8

### 4.7 Plan de tests
*À remplir — unit `MatchingService` ≥ 80 %, intégration `POST /missions` + race condition acceptation, Detox happy path mobile.*

### 4.8 Rollout
*À remplir — feature flag `FF_MISSIONS` (probablement `oui` pour rollback rapide), migration data (vide → MVP).*

### 4.9 Definition of Done — Design
*À remplir — DoD §4.9 du template.*

---

## 5. Phase BUILD

⛔ Bloquée tant que Design DoD non validée.

---

## 6. Phase VERIFY

⛔ Bloquée tant que Build DoD non validée.

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

- [ ] **Discover** : DoD ✅ + validation humaine — **en attente CTO** (Q1–Q10)
- [ ] **Design** : bloqué
- [ ] **Build** : bloqué
- [ ] **Verify** : bloqué
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-002 v0.1 — Discover ouvert le 2026-05-12 — méthode [BMAD-light](../method/BMAD.md).*
