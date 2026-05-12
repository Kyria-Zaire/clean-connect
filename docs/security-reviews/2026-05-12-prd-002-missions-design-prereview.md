# Pré-revue sécurité — Design PRD-002 Missions & Géolocalisation

| Champ | Valeur |
|---|---|
| **Date** | 2026-05-12 |
| **Reviewer** | CTO + `reviewer-securite-code` (posture BMAD Design, risques Discover ≥ 4) |
| **PRD** | `docs/prd/PRD-002-missions-geolocalisation.md` |
| **Périmètre** | Schéma Prisma + migration SQL + contrats Zod + machine d’état + politique d’adresse + ADR-005/006/007 |
| **Statut** | **Pré-revue Design OK — Build interdit sans validation humaine CTO du Design (Ticket 2.1).** |

---

## Synthèse

| Sévérité | Compte | Commentaire |
|---|---:|---|
| Critical | 0 | — |
| Important | 0 | — |
| Suggestion | 2 | Voir §4 |
| Conforme | 11 | Voir §3 |

**Verdict** : aucun blocage **Important** / **Critical** pour démarrer le **Build** une fois le **sign-off Design CTO** obtenu.

---

## 3. Checklist conforme (extraits)

1. **RBAC / ownership** : lecture/écriture missions limitée par rôle + `client_id` / `prestataire_id` / `mission_proposals` — spécifié dans le PRD §4.3 (Build : `RolesGuard` + checks service, **zéro** logique dans controllers).
2. **Anti-IDOR** : `GET /missions/:id` — 404 si pas de lien viewer ↔ mission (PRD §4.3).
3. **Adresse** : politique explicite `mission-address.policy.ts` — masquage CP + distance approx avant acceptation ; adresse complète seulement client / admin / prestataire assigné (PRD Q6).
4. **PostGIS uniquement** pour décisions rayon / matching (`ST_DWithin` sur `geography`) — ADR-003 + ADR-006.
5. **Concurrence acceptation** : transaction SQL + condition `prestataire_id IS NULL` + existence `mission_proposals` — ADR-005.
6. **Pas de secrets** dans schéma Zod / machine d’état.
7. **Enum statut unique** : `MissionStatusSchema` (`@cc/shared-types`) aligné mot pour mot avec Prisma `enum MissionStatus` — pas d’enum divergent côté mobile (import package partagé).
8. **Transitions impossibles côté type** : `MISSION_TRANSITIONS_MVP` exhaustif + `assertMissionTransition` (tests unitaires).
9. **PII / logs** : ADR-006 impose logs sans adresse complète ; Build à valider en Verify.
10. **Rate-limit** : à appliquer sur `POST /missions`, `POST .../publish`, `POST .../accept` en Build (non objet de ce livrable Design).
11. **Migration destructive** : documentée (truncate missions/photos) — acceptable **pré-prod** ; interdit sans procédure en prod (Build/Verify).

---

## 4. Suggestions (non bloquantes)

| # | Suggestion | Suivi |
|---|-----|-----|
| S1 | Ajouter en Verify un test d’intégration `EXPLAIN` pour prouver `Index Scan` sur `addresses_location_gist` lors du matching. | Dette `debt-postgis-explain-ci` |
| S2 | Prévoir header `Idempotency-Key` sur `POST /missions` en Build pour éviter doubles créations réseau mobile. | PRD-002 Build |

---

## 5. Points hors périmètre Design (Build obligatoire)

- Implémentation NestJS `MissionsModule`, `MatchingModule`, processors BullMQ, DTOs `nestjs-zod`, OpenAPI.
- Géocodeur HTTP BAN + validation repli GPS client.
- Génération atomique `mission_number` format `CC-YYYY-NNNNNN`.
- Tests d’intégration Postgres + scénarios race `accept`.

---

*Document généré dans le cadre BMAD-light — phase Design PRD-002.*
