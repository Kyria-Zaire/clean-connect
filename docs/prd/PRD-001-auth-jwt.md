# PRD-001 — Auth JWT (signup / login / refresh / logout / me)

> **PRD** = *Product Requirements Document*
> Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md) §2 (Onboarding) et §3 (Stack).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-001` |
| **Slug** | `auth-jwt` |
| **Titre** | Authentification JWT — signup / login / refresh / logout / me |
| **Version PRD** | `0.1` (Discover) |
| **Statut** | `DRAFT` |
| **Owner produit** | CTO Clean Connect |
| **Owner technique** | `senior-dev` + `architecte-api` |
| **Persona pilote** | `senior-dev` (Discover), `architecte-api` (Design + Build BE), `mobile` (Build FE) |
| **Créé le** | 2026-05-11 |
| **Mis à jour le** | 2026-05-11 |
| **Cible de release** | MVP (Sprint 1) |
| **T-shirt size** | M |
| **Lien Cahier v1.4** | §2 Stratégie Mobile App Unique (Onboarding), §3 Stack Backend, §3.4 Sécurité |

---

## 1. Contexte & problème

### 1.1 Pourquoi cette feature ?

Toutes les autres features (missions, paiements, photos, notifications) nécessitent une identité authentifiée pour distinguer client / prestataire / admin et appliquer les guards d'autorisation. Sprint 0 a posé l'usine logicielle (CI, Docker, Prisma, NestJS bootstrap, `/v1/readyz`) ; sans authentification fonctionnelle, **aucun endpoint métier ne peut être exposé en sécurité**. PRD-001 est le prérequis dur de PRD-002 (Missions), PRD-003 (Paiements/Escrow), etc.

### 1.2 Personas concernés

- [x] Client (particulier ayant besoin d'un nettoyage spécialisé)
- [x] Prestataire (professionnel du nettoyage)
- [x] Admin interne (Clean Connect ops)
- [ ] Système (job automatique, webhook, cron) — *non concerné : machine-to-machine = clés signées, hors scope MVP*

### 1.3 Métriques de succès

| Métrique | Baseline | Cible | Comment mesurer |
|---|---|---|---|
| Taux d'échec signup (erreur 5xx) | N/A | < 0,5 % | logs Pino `route=/v1/auth/signup status>=500` / total |
| Temps médian `POST /v1/auth/login` (hashage compris) | N/A | < 300 ms | log Pino `responseTime` p50 |
| Taux d'échec login (mauvais credentials) — proxy détection brute-force | N/A | alerte si > 30 % sur 5 min | logs Pino + rate-limiter throttler |
| % de sessions rafraîchies sans re-login (J+7) | N/A | ≥ 80 % | events `auth.refresh.success` / sessions actives |
| Couverture tests `auth/` | 0 % | ≥ 80 % (palier strict du `jest.config`) | rapport Jest `--coverage` |

### 1.4 Out of scope

- ❌ Connexion sociale (Google / Apple / Facebook) — backlog post-MVP
- ❌ OTP SMS / appel téléphonique — backlog post-MVP
- ❌ Reset password / mot de passe oublié — sera traité en **PRD-001b** (suivi immédiat, mais hors de ce PRD pour rester ≤ M)
- ❌ Vérification email (lien de confirmation) — backlog post-MVP, l'utilisateur peut consommer l'API dès signup
- ❌ Multi-Factor Authentication (TOTP) — backlog admin uniquement, post-MVP
- ❌ Refresh-token rotation cross-device avec session listing — réservé à une feature « gestion des sessions » dédiée
- ❌ Onboarding produit complet (Stripe Connect KYC prestataire, SetupIntent client) — couvert par les PRDs paiement
- ❌ Écrans mobile design final (graphisme final, animations, copywriting marketing) — version *bootstrap* uniquement (Ticket 1.4 = formulaires fonctionnels, pas finis)

---

## 2. User stories & critères d'acceptance

### 2.1 Story 1 — Création de compte

**En tant que** visiteur (futur client ou prestataire)
**Je veux** créer un compte avec mes identifiants
**Pour** accéder aux services Clean Connect avec un rôle défini

**Critères d'acceptance** :
- [ ] **AC-1.1** — Étant donné un email non utilisé, un mot de passe ≥ 12 caractères respectant la politique (cf. §3.3 Q4) et un rôle dans `{CLIENT, PRESTATAIRE}`, quand le visiteur appelle `POST /v1/auth/signup`, alors la réponse est `201` avec `{ user: { id, email, role, createdAt }, accessToken, refreshToken }` (corps body, **pas en cookie** en MVP — cf. §3.3 Q3).
- [ ] **AC-1.2** — Étant donné un email **déjà utilisé** (case-insensitive), quand `POST /v1/auth/signup`, alors la réponse est `409 Conflict` avec body générique `{ error: "EMAIL_ALREADY_USED" }`, **sans révéler** l'existence ni le rôle de l'utilisateur (formulation à valider en Design avec `reviewer-securite-code` — cf. §3.3 Q6).
- [ ] **AC-1.3** — Le mot de passe n'apparaît jamais en clair dans la DB, dans les logs Pino, ni dans la réponse API. Vérifié par test d'intégration `expect(response.body).not.toContain(password)` + assertion DB `passwordHash !== password`.
- [ ] **AC-1.4** — Validation Zod stricte (`.strict()`) refuse tout champ inconnu (`firstName`, `address`, etc.) avec `400` — la création de profil étendu sera un PRD séparé.
- [ ] **AC-1.5** — Le rôle `ADMIN` est **refusé** au signup public (`400 Bad Request`). Les admins sont créés via seed/console dans une procédure interne, hors PRD-001.

**Cas d'erreur à couvrir** :
- [ ] Email mal formé → `400`
- [ ] Mot de passe trop court / faible → `400` avec code structuré (cf. §3.3 Q4)
- [ ] Body manquant ou JSON malformé → `400`

---

### 2.2 Story 2 — Connexion

**En tant qu'**utilisateur enregistré
**Je veux** me connecter avec mon email + mot de passe
**Pour** obtenir une session active

**Critères d'acceptance** :
- [ ] **AC-2.1** — Étant donné des credentials valides, quand `POST /v1/auth/login`, alors la réponse est `200` avec `{ user: { id, email, role }, accessToken, refreshToken }`. Un nouveau `RefreshToken` est inséré en DB (hash sha256 stocké), avec `expiresAt = now + 30 jours`.
- [ ] **AC-2.2** — Étant donné des credentials invalides (email inconnu OU mot de passe faux), quand `POST /v1/auth/login`, alors la réponse est `401 Unauthorized` avec body générique `{ error: "INVALID_CREDENTIALS" }`. **Aucun moyen** de distinguer "email inexistant" vs "mauvais mot de passe" (anti-énumération).
- [ ] **AC-2.3** — Étant donné un user soft-deleted (`deletedAt != null`), `POST /v1/auth/login` retourne aussi `401 INVALID_CREDENTIALS` (jamais "compte supprimé" → fuite d'information).
- [ ] **AC-2.4** — Aucun mot de passe (ni en clair, ni hashé) ne sort dans le payload.
- [ ] **AC-2.5** — Le rate limiter rejette > 10 tentatives `POST /v1/auth/login` par 60 s par IP **et** par email (cumulatif) → `429 Too Many Requests`.

**Cas d'erreur à couvrir** :
- [ ] Compte soft-deleted → `401 INVALID_CREDENTIALS`
- [ ] Force brute (> 10 / min) → `429`

---

### 2.3 Story 3 — Access token court + refresh token long

**En tant qu'**utilisateur connecté
**Je veux** un access token court et un refresh token long
**Pour** garder une session pratique sans compromettre la sécurité en cas de fuite

**Critères d'acceptance** :
- [ ] **AC-3.1** — L'access token JWT a une durée de vie de **15 minutes** (`exp` claim). Décodé par tout middleware, **jamais stocké en DB côté API** (JWT stateless).
- [ ] **AC-3.2** — Le refresh token a une durée de vie de **30 jours**. Il est généré aléatoirement (`crypto.randomBytes(48).toString('base64url')`, pas un JWT) et n'est **jamais stocké en clair** côté API : seul son `sha256(token)` est persistant.
- [ ] **AC-3.3** — Les deux tokens sont retournés dans le **body** des endpoints `signup`, `login`, `refresh`. Le stockage côté client est de sa responsabilité (`expo-secure-store` côté mobile — cf. AC-4.x du Ticket 1.4).
- [ ] **AC-3.4** — Aucun token (access ni refresh, ni leurs hash) n'apparaît dans les logs (validation via redactor Pino).

---

### 2.4 Story 4 — Rafraîchissement de session

**En tant qu'**utilisateur dont l'access token expire
**Je veux** rafraîchir ma session avec mon refresh token
**Pour** continuer à utiliser l'app sans me reconnecter manuellement

**Critères d'acceptance** :
- [ ] **AC-4.1** — Étant donné un refresh token **valide, non expiré, non révoqué**, quand `POST /v1/auth/refresh` avec `{ refreshToken }`, alors la réponse est `200` avec `{ accessToken, refreshToken }` (nouveaux). Le `RefreshToken` précédent est **marqué `revokedAt = now`** (rotation) et un nouveau est inséré.
- [ ] **AC-4.2** — Étant donné un refresh token **expiré**, `POST /v1/auth/refresh` retourne `401 INVALID_REFRESH_TOKEN`.
- [ ] **AC-4.3** — Étant donné un refresh token **déjà révoqué** (`revokedAt != null`), `POST /v1/auth/refresh` retourne `401 INVALID_REFRESH_TOKEN` ET **révoque tous les autres refresh tokens actifs** de l'utilisateur (signal de compromission probable — cf. §3.3 Q5).
- [ ] **AC-4.4** — Étant donné un refresh token **inexistant en DB** (hash non trouvé), `POST /v1/auth/refresh` retourne `401 INVALID_REFRESH_TOKEN` (jamais 404 → fuite d'info).
- [ ] **AC-4.5** — La rotation est **atomique** en transaction Prisma : insertion du nouveau + révocation de l'ancien dans la même `$transaction`, sinon rollback.

**Cas d'erreur à couvrir** :
- [ ] Token expiré → `401`
- [ ] Token déjà révoqué → `401` + révocation chain de l'utilisateur
- [ ] Token forgé / corrompu → `401`

---

### 2.5 Story 5 — Déconnexion

**En tant qu'**utilisateur connecté
**Je veux** me déconnecter
**Pour** invalider mon refresh token (perte d'appareil, fin de session)

**Critères d'acceptance** :
- [ ] **AC-5.1** — Étant donné un refresh token valide, quand `POST /v1/auth/logout` avec `{ refreshToken }`, alors le `RefreshToken` est marqué `revokedAt = now`. Réponse `204 No Content`.
- [ ] **AC-5.2** — Étant donné un refresh token déjà révoqué ou inconnu, `POST /v1/auth/logout` retourne **aussi `204`** (idempotent — pas d'info leak sur l'existence du token).
- [ ] **AC-5.3** — Le logout **ne révoque que le refresh token transmis** (les autres devices restent connectés). Une story future « logout all devices » pourra agréger.
- [ ] **AC-5.4** — Après logout, `POST /v1/auth/refresh` avec ce même token retourne `401`.

---

### 2.6 Story 6 — Protection des endpoints (refus tokens invalides)

**En tant qu'**API Clean Connect
**Je veux** refuser tout access token expiré, mal signé, ou inconnu
**Pour** garantir qu'aucune ressource protégée n'est servie sans authentification valide

**Critères d'acceptance** :
- [ ] **AC-6.1** — Tout endpoint annoté `@UseGuards(JwtAuthGuard)` retourne `401` si l'header `Authorization: Bearer <token>` est absent, vide, ou mal formaté.
- [ ] **AC-6.2** — Un access token expiré (`exp` passé) retourne `401`.
- [ ] **AC-6.3** — Un access token avec signature invalide (autre `JWT_SECRET`) retourne `401`.
- [ ] **AC-6.4** — `GET /v1/auth/me` avec un access token valide retourne `200` avec `{ id, email, role, createdAt }` du user (PAS de mot de passe, PAS de hash, PAS de refresh tokens listés).
- [ ] **AC-6.5** — Le payload JWT contient au minimum `{ sub: userId, role }` et **ne contient pas** d'email en clair, de PII étendue ou de secrets.

**Cas d'erreur à couvrir** :
- [ ] Header `Authorization` absent → `401`
- [ ] Bearer mal formaté → `401`
- [ ] Token expiré → `401`
- [ ] Signature invalide → `401`
- [ ] User soft-deleted entre l'émission du token et son usage → `401`

---

## 3. Phase DISCOVER

### 3.1 Risk assessment (1 = faible, 5 = critique)

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| **Sécurité** | **5/5** | Auth = surface d'attaque #1. Toute fuite/régression compromet l'ensemble. | ✅ Pré-revue `reviewer-securite-code` obligatoire en fin de Design (avant Build) + audit complet en Verify |
| **RGPD** | 3/5 | Email = PII. Logs Pino doivent rejeter email/password/tokens. Soft delete déjà prévu (`deletedAt`). | Vérification redactor Pino + test d'absence d'email dans logs |
| **Financier (paiement, escrow)** | 1/5 | Aucun lien direct paiement dans ce PRD. Stripe arrive en PRD-003. | N/A |
| **UX (régression)** | 2/5 | Pas de feature préexistante à régresser. App vide aujourd'hui. | N/A |
| **Performance** | 3/5 | Hashage bcrypt cost 10 = ~80 ms / request. Index sur `email` + `RefreshToken.tokenHash` critiques. | Bench p95 login < 500 ms en intégration ; index review sur migration |
| **Disponibilité (dépendance externe)** | 1/5 | Aucune dépendance externe (Stripe, FCM, etc.) sur ce PRD. | N/A |

→ Sécurité **5/5** déclenche **pré-revue `reviewer-securite-code` obligatoire** avant passage Design → Build (cf. méthode BMAD §6).

### 3.2 Modules touchés

- [x] `apps/api/src/modules/auth/*` — création du module (AuthController, AuthService, JwtStrategy, guards, DTOs)
- [x] `apps/api/src/modules/users/*` — extension (lookup user pour login, soft-delete check)
- [x] `apps/api/src/common/decorators/*` — `@CurrentUser`, `@Public` (route publique = bypass JwtAuthGuard)
- [x] `apps/api/src/common/guards/*` — `JwtAuthGuard`, `RoleGuard` (préparation, utilisation effective sur autres PRD)
- [x] `apps/api/prisma/schema.prisma` — nouveau modèle `RefreshToken` + relation User (Cascade)
- [x] `apps/api/prisma/migrations/<date>_auth_refresh_token/migration.sql` — migration générée
- [x] `apps/mobile/src/features/auth/*` — écrans signup/login + Zustand auth store + appels API
- [x] `apps/mobile/app/(auth)/*` — routes Expo Router pour les écrans non protégés
- [x] `apps/mobile/src/lib/auth/*` — client API auth, persistance via `expo-secure-store`, RoleGuard connecté
- [x] `packages/shared-types/src/zod/auth.ts` — schemas Zod signup/login/refresh/logout/me (sortie + DTOs)
- [x] Configuration : `apps/api/src/config/jwt.config.ts` (lecture `JWT_SECRET`, `JWT_REFRESH_SECRET` Zod-validés)
- [x] CI : pas de changement structurel attendu (les jobs existants couvrent typecheck/lint/test/integration/docker)

### 3.3 Open questions (à résoudre AVANT Design)

> Toute question non résolue ici bloque le passage en Design.

| # | Question | Owner | Statut | Réponse |
|---|---|---|---|---|
| Q1 | Le champ **`phone`** mentionné dans les user stories CTO n'existe pas dans le `model User` actuel (cahier v1.4 : signup = email + mot de passe + nom). On l'ajoute en MVP (migration) ou on le repousse à un PRD « profil » ? | CTO | **RESOLVED** | **Repoussé hors PRD-001.** Signup MVP = email + password + role (+ name à ajouter, cf. Q2). Téléphone = futur PRD « profil utilisateur » avec validation OTP. Évite d'introduire un champ non vérifié dans le User. |
| Q2 | Idem pour **`name`** / `firstName` / `lastName` : ajouter au signup dès maintenant ? | CTO | **RESOLVED** | **Inclus** : ajouter `firstName String @db.VarChar(80)` et `lastName String @db.VarChar(80)` (obligatoires) sur `User`. Justifié par le cahier v1.4 §2 (signup demande explicitement « nom ») et par le besoin d'afficher un identifiant lisible (admin, futur écran prestataire). Migration mineure portée par PRD-001. |
| Q3 | Transport tokens : **body JSON** ou **httpOnly cookie** ? | senior-dev | **RESOLVED** | **Body JSON.** Le client est principalement mobile (Expo) où les cookies httpOnly ne s'appliquent pas naturellement. L'admin web pourra basculer cookie en PRD-Admin Auth ultérieur. Décision actée en **ADR-004** (à produire en Design). |
| Q4 | Politique mot de passe MVP : longueur min ? Caractères spéciaux ? | senior-dev + reviewer-securite-code | **RESOLVED** | **≥ 12 caractères**, refus si dans top 10 000 mots de passe communs (liste statique embarquée, pas de service externe en MVP). Pas d'exigence de classes de caractères (NIST SP 800-63B). Erreur structurée `WEAK_PASSWORD` + champ `reason`. |
| Q5 | En cas de **détection de réutilisation d'un refresh token déjà révoqué**, on fait quoi ? | reviewer-securite-code | **RESOLVED** | **Révocation en cascade** de tous les refresh tokens actifs de l'utilisateur (`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL`). Pattern OAuth2 RFC 6819 §5.2.2.3 — signal de fuite probable. |
| Q6 | Sur `signup`, faut-il **masquer** la cause de l'échec quand l'email existe déjà ? | reviewer-securite-code | **RESOLVED** | **Compromis pragmatique.** On accepte le `409 EMAIL_ALREADY_USED` pour l'UX (formulaires mobiles ont besoin de cette info). On compense par un **rate-limit signup** strict (3/min/IP) qui rend l'énumération impraticable. Décision documentée en ADR-004. |
| Q7 | Multi-device : un user peut-il avoir **plusieurs refresh tokens actifs** en parallèle (téléphone + tablette + admin web) ? | senior-dev | **RESOLVED** | **Oui, multi-device autorisé.** Le modèle `RefreshToken` est `N:1 User`, plusieurs `revokedAt IS NULL` pour un même `userId`. Pas de limite hard (alerte > 5 sessions actives → métrique, sans blocage MVP). |
| Q8 | L'access token doit-il porter **`role`** ? | architecte-api | **RESOLVED** | **Oui.** Le `RoleGuard` lit le claim depuis le JWT (zéro round-trip DB pour autoriser). Trade-off : un changement de rôle nécessite un re-login (ou refresh). Acceptable car les changements de rôle sont **rares** (admin promu, prestataire activé). |
| Q9 | L'access token doit-il porter **`stripeAccountId` / `stripeCustomerId`** ? | architecte-api | **RESOLVED** | **Non.** Garder le payload minimal `{ sub, role, iat, exp, jti }`. Les IDs Stripe sont lus côté API si nécessaire. Évite la fuite d'IDs externes via inspection de JWT. |

→ **Toutes les open questions sont `RESOLVED`** : feu vert pour le passage Discover → Design (sous réserve validation humaine §3.4).

### 3.4 Definition of Done — Discover

- [x] PRD instancié avec ID, slug, statut `DRAFT`
- [x] Lien explicite vers section du cahier v1.4 (§2 + §3)
- [x] ≥ 1 user story avec critères d'acceptance testables (**6 stories, 26 ACs**)
- [x] Risk assessment renseigné (sécurité = 5/5 → pré-revue obligatoire en Design)
- [x] Métriques de succès quantifiables
- [x] Out of scope listé (8 items)
- [x] Open questions toutes résolues (9 / 9 `RESOLVED`)
- [x] T-shirt size estimé (M)
- [ ] **Validation humaine** (Owner produit = CTO) : nom + date

> ✍️ En attente de validation Discover par CTO le `YYYY-MM-DD`.

---

## 4. Phase DESIGN

> *À compléter en Ticket 1.2 après validation Discover.*

### 4.1 Schéma DB (Prisma)
TBD — Ticket 1.2

### 4.2 Schémas Zod (`packages/shared-types`)
TBD — Ticket 1.2

### 4.3 Contrat API
TBD — Ticket 1.2

### 4.4 Contrat UI
TBD — Ticket 1.2

### 4.5 Effets de bord, jobs, webhooks
TBD — Ticket 1.2

### 4.6 ADR liées
- `docs/adr/ADR-004-auth-tokens-strategy.md` (à produire en Ticket 1.2) — choix body JSON vs cookie, hashage refresh token, rotation, révocation en cascade.

### 4.7 Plan de tests
TBD — Ticket 1.2

### 4.8 Rollout
TBD — Ticket 1.2

### 4.9 Definition of Done — Design
TBD — Ticket 1.2

---

## 5. Phase BUILD

> *À compléter en Tickets 1.3 (API), 1.4 (Mobile), 1.5 (Tests).*

### 5.1 Branches & PRs
| Branche | Description | PR | Statut |
|---|---|---|---|
| `feat/prd-001-auth-jwt` | Tout PRD-001 (mono-PR pour rester atomique sur le scope auth) | TBD | TBD |

### 5.2 Commits clés
TBD

### 5.3 Migration appliquée
TBD

### 5.4 TODO(debt) introduits
TBD

### 5.5 Captures d'écran
TBD

### 5.6 Definition of Done — Build
TBD

---

## 6. Phase VERIFY

> *À compléter en Ticket 1.6.*

### 6.1 Audit sécurité
TBD — `reviewer-securite-code`, rapport `docs/security-reviews/<date>-PRD-001.md`

### 6.2 Performance
TBD

### 6.3 RGPD
TBD

### 6.4 Manual QA (recette)
TBD

### 6.5 Smoke test paiement
N/A — pas de paiement dans ce PRD.

### 6.6 Plan de rollback testé
TBD

### 6.7 Métriques instrumentées
TBD

### 6.8 Definition of Done — Verify
TBD

---

## 7. Post-release

TBD

---

## 8. Annexes

### 8.1 Recherches / benchmarks
- NIST SP 800-63B (Digital Identity Guidelines, §5.1.1.2 sur les password policies)
- OAuth 2.0 Threat Model and Security Considerations (RFC 6819), §5.2.2 (refresh token theft & rotation)
- Auth0 — *Refresh Token Rotation* (2022) — pattern de révocation en cascade

### 8.2 Refusés / alternatives non retenues

| Alternative | Pourquoi non retenue |
|---|---|
| **OAuth 2.0 + provider Google/Apple/Facebook au MVP** | Allonge le scope, dépendance externe, et nécessite du provisioning produit (Apple Developer, GCP). Reporté post-MVP. |
| **Session côté serveur (cookie + Redis)** | Coût opérationnel (eviction sessions, scaling Redis), perte de l'avantage stateless du JWT. Acceptable pour admin web en V2. |
| **Refresh token signé JWT (au lieu d'un opaque random)** | Le JWT en clair contiendrait le `userId` lisible par tout porteur. Préférable : opaque random + hash sha256 en DB → équivalent à un secret partagé révocable. |
| **Argon2id (au lieu de bcrypt)** | Plus moderne, mais moins mature dans l'écosystème Node (libs C++ bindings instables, cold start lent). Bcrypt cost 10 = 80 ms acceptable, choisi explicitement par le CTO. |
| **Stockage refresh token en clair en DB** | Compromission DB = vol direct des tokens. Hash sha256 → fuite DB n'expose pas les tokens utilisables. |

### 8.3 Glossaire

| Terme | Définition |
|---|---|
| **Access token** | JWT court (15 min) porté dans `Authorization: Bearer`, stateless, contient `{ sub, role, jti, iat, exp }`. |
| **Refresh token** | Chaîne opaque longue (48 octets base64url), durée 30 j, stocké hashé (sha256) côté serveur, opaque côté client. |
| **Rotation** | À chaque `/refresh`, l'ancien refresh token est révoqué et un nouveau émis (anti-replay). |
| **Révocation en cascade** | Si un refresh token déjà révoqué est rejoué, tous les refresh tokens actifs du même user sont révoqués (probable compromission). |
| **Idempotence logout** | `/logout` retourne `204` que le token soit valide, expiré ou inconnu — pas de fuite d'info. |

---

## 9. Checklist BMAD globale (à cocher avant `DONE`)

- [ ] **Discover** : DoD ✅ + validation humaine
- [ ] **Design** : DoD ✅ + validation humaine
- [ ] **Build** : DoD ✅ + validation humaine
- [ ] **Verify** : DoD ✅ + double validation (produit + technique)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*PRD-001 — créé par `senior-dev` le 2026-05-11 — Sprint 1 Clean Connect — méthode [BMAD-light](../method/BMAD.md).*
