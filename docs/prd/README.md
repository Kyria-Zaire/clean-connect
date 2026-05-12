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
| [PRD-003](PRD-003-photos-paiements.md) | `photos-paiements` | Photos AVANT/APRÈS + Stripe Connect Express (capture manual + delayed transfer + auto-release T+48h ouvrées + DLQ + reconcile + refunds admin) | 🟧 `RELEASE_CANDIDATE` (Build + Verify validés CTO PR #11 #12 #13 — étapes humaines restantes : smoke recette/preprod, perf §6.3, sign-off RGPD, tag) | S3 | CTO | `architecte-api` + `securite` + `stripe` + `photos-rgpd` | _en attente tag `v3.0.0-prd003`_ |
| [PRD-004](PRD-004-hardening-ops-compliance.md) | `hardening-ops-compliance` | Hardening, Ops & Compliance (Sentry/OTel + retry/recovery BullMQ + admin tooling UI + RGPD avancé + monitoring financier) — 5 tickets (4.1 → 4.5) | 🟡 `DISCOVER_DRAFT` (ouvert 2026-05-12 — validation CTO requise pour passer en Design) | S4 | _à désigner_ | `ingenieur` + `architecte-api` + `photos-rgpd` + `stripe` (Design — à confirmer OQ-9) | — |

---

## Dépendances fonctionnelles

```
PRD-001 (Auth)                                ← ✅ DONE
   └─→ PRD-002 (Missions & Géolocalisation)   ← ✅ DONE
          └─→ PRD-003 (Photos + Paiements Stripe Connect escrow)   ← 🟧 Release-candidate
                 └─→ PRD-004 (Hardening, Ops & Compliance)   ← 🟡 Discover en cours
                        ├─→ PRD-005 (Disputes / Litiges — process complet client / prestataire / arbitrage admin) — backlog
                        └─→ PRD-006 (Notifications avancées + reporting client/prestataire) — backlog
```

PRD-004 doit se finir **avant** PRD-005 : sans observabilité ni admin tooling (4.1 + 4.3), instruire un dispute revient à du `psql` + Stripe Dashboard.

> **Règle dure** : aucune feature aval ne démarre tant que sa dépendance n'est pas en statut `DONE` (cf. [BMAD-light §0 Pourquoi](../method/BMAD.md)).

---

## Sprints

| Sprint | Périmètre | Statut | Référence |
|---|---|:-:|---|
| **Sprint 0** | Bootstrap monorepo / Docker / Prisma / NestJS / Expo / CI / readyz | ✅ Terminé | [`docs/CAHIER-DES-CHARGES-v1.4.md`](../CAHIER-DES-CHARGES-v1.4.md) |
| **Sprint 1** | PRD-001 Auth JWT (API + mobile bootstrap) | ✅ Terminé (`v0.1.0-auth-foundation`) | [PRD-001](PRD-001-auth-jwt.md) + [audit final](../security-reviews/2026-05-12-prd-001-auth-verify.md) |
| **Sprint 2** | PRD-002 Missions & Géolocalisation | ✅ Terminé (`v0.2.0-missions-foundation` — sign-off CTO 2026-05-12) | [PRD-002](PRD-002-missions-geolocalisation.md) + [audit Verify](../security-reviews/2026-05-12-prd-002-missions-build-verify.md) |
| **Sprint 3** | PRD-003 Photos AVANT/APRÈS + Stripe Connect Express | 🟧 Release-candidate (Build + Verify validés CTO PR #11 #12 #13 — étapes humaines restantes avant tag `v3.0.0-prd003`) | [PRD-003](PRD-003-photos-paiements.md) + [audit Verify final](../verify/PRD-003-audit-securite-ticket-3-6.md) + [runbook release](../release/v3.0.0-prd003.md) |
| **Sprint 4** | PRD-004 Hardening, Ops & Compliance (Sentry/OTel + retry/recovery + admin UI + RGPD + monitoring financier) | 🟡 Discover ouvert 2026-05-12 — validation CTO requise pour Design | [PRD-004](PRD-004-hardening-ops-compliance.md) |
| Sprint 5+ | PRD-005 (Disputes) → PRD-006 (Notifications avancées) — bloqués tant que PRD-004 non `DONE` | ⏳ Backlog | — |

---

*Index mis à jour à chaque ouverture / clôture de PRD.*
