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
| [PRD-002](PRD-002-missions-geolocalisation.md) | `missions-geolocalisation` | Missions & Géolocalisation (entity, états, scheduling, matching PostGIS) | ✅ `DONE` | S2 | CTO | `senior-dev` + `architecte-api` + `mobile` | [`v0.2.0-missions-foundation`](../../CHANGELOG.md) |
| [PRD-003](PRD-003-photos-paiements.md) | `photos-paiements` | Photos AVANT/APRÈS + Stripe Connect Express (`capture_method='manual'` + delayed transfer + auto-release T+48h ouvrées) — 4 sous-systèmes (Onboarding / Payment Lifecycle / Media Evidence / Mission Completion) | ✅ `DISCOVER_DONE` (sign-off CTO 2026-05-12) → 🟡 Design en cours sur `design/prd-003-photos-paiements` | S3 | CTO | `architecte-api` + `securite` + `stripe` + `photos-rgpd` (Design) | — |

---

## Dépendances fonctionnelles

```
PRD-001 (Auth)                                ← ✅ DONE
   └─→ PRD-002 (Missions & Géolocalisation)   ← ✅ DONE
          └─→ PRD-003 (Photos AVANT/APRÈS + Stripe Connect Escrow)   ← 🟡 Discover en cours
                 ├─→ PRD-004 (Notifications FCM + Email — Postmark/SendGrid)
                 ├─→ PRD-005 (Disputes / Litiges — process complet remboursement / arbitrage)
                 └─→ PRD-006 (Admin dashboard — paiements, DLQ, KPIs, modération)
```

PRD-003 fusionne **Photos AVANT/APRÈS** et **Paiements Stripe Connect Express** car les deux sont indissociables :
- les photos servent de **preuve de complétion** sans laquelle le paiement ne peut être libéré (escrow conditionnel) ;
- le paiement n'a pas de sens sans la preuve photo (litiges impossibles).

> **Règle dure** : aucune feature aval ne démarre tant que sa dépendance n'est pas en statut `DONE` (cf. [BMAD-light §0 Pourquoi](../method/BMAD.md)).

---

## Sprints

| Sprint | Périmètre | Statut | Référence |
|---|---|:-:|---|
| **Sprint 0** | Bootstrap monorepo / Docker / Prisma / NestJS / Expo / CI / readyz | ✅ Terminé | [`docs/CAHIER-DES-CHARGES-v1.4.md`](../CAHIER-DES-CHARGES-v1.4.md) |
| **Sprint 1** | PRD-001 Auth JWT (API + mobile bootstrap) | ✅ Terminé (`v0.1.0-auth-foundation`) | [PRD-001](PRD-001-auth-jwt.md) + [audit final](../security-reviews/2026-05-12-prd-001-auth-verify.md) |
| **Sprint 2** | PRD-002 Missions & Géolocalisation | ✅ Terminé (`v0.2.0-missions-foundation` — sign-off CTO 2026-05-12) | [PRD-002](PRD-002-missions-geolocalisation.md) + [audit Verify](../security-reviews/2026-05-12-prd-002-missions-build-verify.md) |
| **Sprint 3** | PRD-003 Photos AVANT/APRÈS + Stripe Connect Express (`capture_method='manual'` + delayed transfer) | ✅ Discover validé (CTO 2026-05-12, 15 OQ + 21 décisions) — 🟡 Design en cours sur `design/prd-003-photos-paiements` (ADRs 008-013, schéma Prisma, contrats Zod) | [PRD-003](PRD-003-photos-paiements.md) |
| Sprint 4+ | PRD-004 (Notifications complètes) → PRD-005 (Disputes) → PRD-006 (Admin) — bloqués tant que PRD-003 non `DONE` | ⏳ Backlog | — |

---

*Index mis à jour à chaque ouverture / clôture de PRD.*
