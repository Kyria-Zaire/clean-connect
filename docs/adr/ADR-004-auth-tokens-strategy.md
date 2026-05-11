# ADR-004 — Stratégie JWT access + refresh opaque (PRD-001)

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-004` |
| **Titre** | Transport des tokens en body JSON, secrets JWT séparés, refresh opaque hashé, rotation et révocation cascade |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` |
| **PRD lié** | `docs/prd/PRD-001-auth-jwt.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-001-auth-design-prereview.md` — **@reviewer-securite-code** (risque Discover 5/5) |

---

## 1. Contexte

- Le client principal est **mobile Expo** : les cookies `httpOnly` ne constituent pas un transport naturel ni homogène avec les apps natives.
- L’**access token** doit rester **court** (15 min), **stateless**, vérifiable sans aller en base à chaque requête autorisée.
- Le **refresh token** doit permettre une session longue (30 j) avec **révocation** serveur, **rotation** à chaque usage, et détection de **rejouer un token déjà révoqué** (compromission probable).
- Le CTO impose une **séparation de configuration** entre `JWT_ACCESS_SECRET` et `JWT_REFRESH_SECRET` : aujourd’hui le refresh est **opaque** (pas signé avec la clé refresh), mais la clé est **réservée** pour éviter toute ambiguïté future (ex. évolution vers un JWT refresh sans mélanger les clés avec l’access).
- Contrainte produit : le signup peut retourner **`409 EMAIL_ALREADY_USED`** ; le risque d’énumération est **compensé** par un rate-limit strict côté `POST /v1/auth/signup`.

---

## 2. Décision

1. **Transport** : `accessToken` et `refreshToken` sont renvoyés dans le **corps JSON** des réponses `signup`, `login`, `refresh` (mobile-first). Pas de dépendance aux cookies pour le MVP auth mobile.
2. **Access token** : JWT signé **uniquement** avec `JWT_ACCESS_SECRET`, durée `JWT_ACCESS_EXPIRES_IN` (défaut `15m`). **Non stocké** en base. Payload **minimal** : au minimum `sub` (user id), `role`, `iat`, `exp`, `jti` — **pas** d’email ni d’IDs Stripe dans le JWT (cf. PRD Q9).
3. **Refresh token** : chaîne **opaque** (ex. `crypto.randomBytes(48)` encodée **base64url**), durée `JWT_REFRESH_EXPIRES_IN` (défaut `30d`). **Jamais** stocké en clair côté API : persistance de **`sha256(token)` en hexadécimal (64 caractères)** dans `refresh_tokens.token_hash` (**unique**).
4. **Rotation** : à chaque `POST /v1/auth/refresh` valide, l’ancienne ligne est **`revoked_at = now()`** et une nouvelle est créée en **transaction** atomique.
5. **Révocation cascade** : si un refresh **déjà révoqué** (ou scénario équivalent de reuse détecté côté implémentation) est présenté, réponse **`401 INVALID_REFRESH_TOKEN`** et **révocation de tous les refresh actifs** du même `user_id` (tokens avec `revoked_at IS NULL`).
6. **Secrets** : `JWT_ACCESS_SECRET` et `JWT_REFRESH_SECRET` sont **tous deux** validés au boot (longueur minimale). **Build** : ajouter une garde explicite **`JWT_ACCESS_SECRET !== JWT_REFRESH_SECRET`** dans `loadEnv()` pour interdire la configuration ambiguë / copier-coller accidentel.
7. **Mot de passe** : hash **bcrypt** avec **coût 10** pour `users.password_hash` (décision CTO Design).
8. **Client mobile** : persistance des tokens via **`expo-secure-store`** (Ticket 1.4), hors scope de cette ADR côté serveur.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| Cookies `httpOnly` + refresh en cookie pour tout le monde | UX et stack **Expo** non alignées ; l’admin web pourra avoir un flux dédié plus tard. |
| Refresh token = JWT signé avec `JWT_REFRESH_SECRET` | Payload lisible côté client ; moins bon contrôle « secret partagé révocable ligne par ligne » qu’un opaque + hash en DB. |
| Masquer totalement l’email existant au signup (`401` générique) | Meilleure confidentialité, mais **UX formulaire** mobile dégradée ; compromis **409 + rate-limit 3/min/IP**. |
| Stockage du refresh en clair en base | Fuite DB = session utilisateur volée immédiatement. |

---

## 4. Conséquences

### Positives

- Cohérence **React Native / Expo** et simplicité d’intégration **OpenAPI / Swagger** pour les tests manuels en Verify.
- Révocation et **audit** possibles par ligne `refresh_tokens`.
- **Rotation** + **cascade** alignées sur les bonnes pratiques OAuth2 (cf. RFC 6819, refresh theft).

### Négatives / coûts assumés

- XSS / exfiltration côté client : le porteur du refresh peut prolonger la session — **mitigation client** (`expo-secure-store`, surface JS minimale) + durées courtes access + rotation.
- `409 EMAIL_ALREADY_USED` : risque résiduel d’énumération — **mitigation** rate-limit signup strict + monitoring.

### Neutres (à surveiller)

- Charge DB sur `/refresh` (lookup par hash + transaction) — acceptable MVP ; indexer `token_hash` (unique) et `user_id`.

---

## 5. Suivi

- [ ] `loadEnv()` : refuser si `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET` (Ticket 1.3 Build).
- [ ] Contrôleurs NestJS : DTOs `nestjs-zod` + décorateurs Swagger sur les routes `POST/GET` auth (Ticket 1.3).
- [ ] Verify : parcours manuel **Swagger** `/api-docs` documenté dans le PRD §6.

---

## 6. Références

- PRD : `docs/prd/PRD-001-auth-jwt.md`
- RFC 6819 — OAuth 2.0 Threat Model (refresh token theft, rotation)
- NIST SP 800-63B (politique mots de passe, pas d’exigence de complexité arbitraire au MVP)
- Schémas Zod : `packages/shared-types/src/zod/auth.ts`

---

*ADR-004 — Clean Connect — BMAD Design PRD-001.*
