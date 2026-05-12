# Index PRD — Clean Connect

> Chaque PRD = une feature ou un module produit, suivi en méthode [BMAD-light](../method/BMAD.md)
> (4 phases : **Discover → Design → Build → Verify**).
> Référence métier : [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md).
> Template : [`docs/templates/PRD-template.md`](../templates/PRD-template.md).

---

## Convention

- **ID** : `PRD-NNN` séquentiel.
- **Slug** : `kebab-case` ; nom de fichier `PRD-NNN-<slug>.md`.
- **Statut** : `DRAFT` → `DISCOVER_DONE` → `DESIGN_DONE` → `BUILD_DONE_PENDING_VERIFY` → `VERIFY_DONE_PENDING_MERGE` → `DONE` (ou `BLOCKED` / `ABANDONED`).
- **Owner produit** vs **Owner technique** : toujours distincts.
- **Tag Git** : à chaque PRD livré (`vX.Y.Z-<slug-court>`).

---

## PRDs

| ID | Slug | Titre | Statut | Sprint | Owner produit | Owner technique | Tag |
|---|---|---|:-:|:-:|---|---|---|
| [PRD-001](PRD-001-auth-jwt.md) | `auth-jwt` | Authentification JWT (signup / login / refresh / logout / me) | ✅ `DONE` | S1 | CTO | `senior-dev` + `architecte-api` + `mobile` | [`v0.1.0-auth-foundation`](../../CHANGELOG.md#v010-auth-foundation--2026-05-12) |
| [PRD-002](PRD-002-missions-geolocalisation.md) | `missions-geolocalisation` | Missions & Géolocalisation (entity, états, scheduling, matching PostGIS) | 🟡 `BUILD_REVIEW` (Verify + sign-off CTO requis) | S2 | CTO | `senior-dev` + `architecte-api` + `mobile` | — |

---

## Dépendances fonctionnelles

```
PRD-001 (Auth)
   └─→ PRD-002 (Missions)    ← bloque
          ├─→ PRD-003 (Paiements / Escrow Stripe)
          └─→ PRD-004 (Photos AVANT/APRÈS + Cloudinary)
                 └─→ PRD-005 (Notifications FCM/email)
                        └─→ PRD-006 (Disputes / Litiges)
                               └─→ PRD-007 (Admin dashboard)
```

> **Règle dure** : aucune feature aval ne démarre tant que sa dépendance n'est pas en statut `DONE` (cf. [BMAD-light §0 Pourquoi](../method/BMAD.md)).

---

## Sprints

| Sprint | Périmètre | Statut | Référence |
|---|---|:-:|---|
| **Sprint 0** | Bootstrap monorepo / Docker / Prisma / NestJS / Expo / CI / readyz | ✅ Terminé | [`docs/CAHIER-DES-CHARGES-v1.4.md`](../CAHIER-DES-CHARGES-v1.4.md) |
| **Sprint 1** | PRD-001 Auth JWT (API + mobile bootstrap) | ✅ Terminé (`v0.1.0-auth-foundation`) | [PRD-001](PRD-001-auth-jwt.md) + [audit final](../security-reviews/2026-05-12-prd-001-auth-verify.md) |
| **Sprint 2** | PRD-002 Missions & Géolocalisation | 🟡 Build livré (Discover + Design validés 2026-05-12) — Verify + sign-off CTO en attente | [PRD-002](PRD-002-missions-geolocalisation.md) |
| Sprint 3+ | PRD-003 Paiements Stripe / Escrow → bloqué tant que Sprint 2 non `DONE` | ⏳ Backlog | — |

---

*Index mis à jour à chaque ouverture / clôture de PRD.*
