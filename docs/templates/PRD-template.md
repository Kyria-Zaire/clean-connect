# PRD-<ID> — <Nom de la feature>

> **PRD** = *Product Requirements Document*
> Un PRD = une feature ou un module. Référence directe au [Cahier des charges v1.4](../CAHIER-DES-CHARGES-v1.4.md).
> Méthode appliquée : [BMAD-light](../method/BMAD.md).
>
> **Comment utiliser ce template** : copier ce fichier dans `docs/prd/<feature-slug>.md`, remplir au fil des phases, **ne jamais supprimer une section** (mettre `N/A` si non applicable, justifier).

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `PRD-XXX` |
| **Slug** | `<feature-slug-kebab-case>` |
| **Titre** | `<Nom de la feature>` |
| **Version PRD** | `0.1` |
| **Statut** | `DRAFT` \| `DESIGN_REVIEW` \| `BUILD` \| `VERIFY` \| `DONE` \| `BLOCKED` |
| **Owner produit** | `<nom humain>` |
| **Owner technique** | `<nom humain>` |
| **Persona pilote** | `<senior-dev / architecte-api / mobile / ...>` |
| **Créé le** | `YYYY-MM-DD` |
| **Mis à jour le** | `YYYY-MM-DD` |
| **Cible de release** | `MVP / v1.1 / v1.2 / backlog` |
| **T-shirt size** | `XS \| S \| M \| L \| XL` |
| **Lien Cahier v1.4** | Section `<n. titre>` |

---

## 1. Contexte & problème

### 1.1 Pourquoi cette feature ?
> 3-5 phrases max. Quel problème utilisateur ou business ? Pourquoi maintenant ?

### 1.2 Personas concernés
- [ ] Client (particulier ayant besoin d'un nettoyage spécialisé)
- [ ] Prestataire (professionnel du nettoyage)
- [ ] Admin interne (Clean Connect ops)
- [ ] Système (job automatique, webhook, cron)

### 1.3 Métriques de succès
> Comment on saura que c'est gagné ? Toujours quantifiable.

| Métrique | Baseline actuelle | Cible | Comment mesurer |
|---|---|---|---|
| Ex : taux de complétion mission | 65 % | 80 % | event `mission.completed` / `mission.created` |
| ... | ... | ... | ... |

### 1.4 Out of scope
> Ce que cette feature **ne fait pas**. Liste explicite pour couper net les dérives.

- ❌ ...
- ❌ ...

---

## 2. User stories & critères d'acceptance

> Format : `En tant que <rôle>, je veux <action> pour <bénéfice>`.
> Chaque story a au moins 1 critère d'acceptance **testable** (donné → quand → alors).

### 2.1 Story 1 — `<titre>`

**En tant que** `<rôle>`
**Je veux** `<action>`
**Pour** `<bénéfice>`

**Critères d'acceptance** :
- [ ] **AC-1.1** — Étant donné `<contexte>`, quand `<action>`, alors `<résultat attendu>`.
- [ ] **AC-1.2** — ...

**Cas d'erreur à couvrir** :
- [ ] ...

### 2.2 Story 2 — ...

---

## 3. Phase DISCOVER

### 3.1 Risk assessment (1 = faible, 5 = critique)

| Domaine | Score | Justification | Action si ≥ 4 |
|---|:-:|---|---|
| Sécurité | _/5 | | Pré-revue `reviewer-securite-code` en Design |
| RGPD | _/5 | | Lecture par référent RGPD |
| Financier (paiement, escrow) | _/5 | | Application stricte `stripe` rule |
| UX (régression) | _/5 | | Tests Detox happy path obligatoires |
| Performance | _/5 | | Plan de charge + index review |
| Disponibilité (dépendance externe) | _/5 | | Plan B / fallback documenté |

### 3.2 Modules touchés

- [ ] `apps/api/src/modules/<module>`
- [ ] `apps/mobile/src/features/<feature>`
- [ ] `apps/admin/src/pages/<page>`
- [ ] `packages/shared-types`
- [ ] `apps/api/prisma/schema.prisma`
- [ ] Configuration / infra / CI

### 3.3 Open questions (à résoudre AVANT Design)

> Toute question non résolue ici bloque le passage en Design.

| # | Question | Owner | Statut | Réponse |
|---|---|---|---|---|
| Q1 | ... | | `OPEN \| RESOLVED` | |

### 3.4 Definition of Done — Discover

- [ ] PRD instancié avec ID, slug, statut `DRAFT`
- [ ] Lien explicite vers section du cahier v1.4
- [ ] ≥ 1 user story avec critères d'acceptance testables
- [ ] Risk assessment renseigné
- [ ] Métriques de succès quantifiables
- [ ] Out of scope listé
- [ ] Open questions toutes résolues (`RESOLVED`)
- [ ] T-shirt size estimé
- [ ] **Validation humaine** (Owner produit) : nom + date

> ✍️ Validé Discover par `<nom>` le `YYYY-MM-DD`.

---

## 4. Phase DESIGN

### 4.1 Schéma DB (Prisma)

> Coller le diff `schema.prisma` proposé. Migration **non encore appliquée**.

```prisma
// AVANT
model Mission {
  id        String   @id @default(uuid())
  // ...
}

// APRÈS (diff visible)
model Mission {
  id        String   @id @default(uuid())
  rating    Int?     // ← nouveau
  // ...

  @@index([rating])  // ← nouveau
}
```

**Nom de migration prévu** : `<YYYYMMDDHHMM>_<slug>`.
**Backward compat** : `compatible / breaking / migration de données requise`.
**Plan migration data** : `N/A | <description>`.

### 4.2 Schémas Zod (`packages/shared-types`)

```typescript
// Base auto-générée via zod-prisma-types
import { MissionSchema } from '@cleanconnect/shared-types/zod'

// DTO entrée
export const rateMissionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
}).strict()
export type RateMissionInput = z.infer<typeof rateMissionSchema>

// DTO sortie
export const rateMissionResponseSchema = MissionSchema.pick({ id: true, rating: true })
```

### 4.3 Contrat API

| Méthode | Route | Auth | Idempotence | Rate limit | Codes HTTP |
|---|---|---|---|---|---|
| `POST` | `/missions/:id/rating` | JWT + `RoleGuard(CLIENT)` + ownership | Header `Idempotency-Key` | 30/min/user | `201`, `400`, `401`, `403`, `404`, `409`, `429` |

**Body** : `rateMissionSchema`
**Réponse** : `rateMissionResponseSchema`
**Effets de bord** :
- [ ] Job BullMQ `notify-prestataire-rated` (FCM topic `user:<prestataireId>`)
- [ ] Audit log `mission.rated`

### 4.4 Contrat UI

#### Mobile
- Écran : `apps/mobile/src/features/missions/RateMissionScreen.tsx`
- States : `idle / submitting / success / error / offline`
- A11y : labels lisibles screen reader, taille bouton ≥ 44pt
- Tokens : NativeWind (`bg-green-500`, `rounded-2xl`, etc.)
- Wireframe / Figma : `<lien>`

#### Admin
- Page : `apps/admin/src/pages/missions/ratings.tsx`
- shadcn/ui components utilisés : `<Table />`, `<DialogDispute />`

### 4.5 Effets de bord, jobs, webhooks

| Type | Nom | Trigger | Idempotence | DLQ |
|---|---|---|---|---|
| BullMQ | `notify-prestataire-rated` | post-rating | jobId = `rating:<missionId>` | oui (max 3 retries) |

### 4.6 ADR liées

> Lien vers ADRs créées (si décision structurante).

- `docs/adr/ADR-XXX-<sujet>.md` — `<résumé>`

### 4.7 Plan de tests

| Niveau | Cible | Outil | Critères couverts |
|---|---|---|---|
| Unit | `RatingService.create()` | Jest | AC-1.1, AC-1.2 |
| Integration | `POST /missions/:id/rating` | Jest + container Postgres+PostGIS éphémère | AC-1.1, cas d'erreur 403/409 |
| E2E mobile | Happy path noter mission | Detox | AC-1.1 |
| Security review | Toute la route | `reviewer-securite-code` | rapport joint |

### 4.8 Rollout

- [ ] Feature flag : `oui / non` (`FF_MISSION_RATING`)
- [ ] Migration data : `N/A | <description>`
- [ ] Plan rollback : `<description>`
- [ ] Order de déploiement : `API → Mobile → Admin` (ou inverse, justifier)

### 4.9 Definition of Done — Design

- [ ] Schéma Prisma proposé (PR draft ouverte)
- [ ] Schémas Zod rédigés
- [ ] Routes API listées avec verbes, codes HTTP, idempotence, rate limit
- [ ] UI states couverts (loading / empty / error / success / offline)
- [ ] Effets de bord listés (jobs, FCM, emails, webhooks)
- [ ] ADR créées si nécessaire
- [ ] Plan de tests explicite
- [ ] Plan rollout + rollback
- [ ] Pré-revue `reviewer-securite-code` si risque ≥ 4 (lecture, pas audit complet)
- [ ] **Validation humaine** (Owner technique) : nom + date

> ✍️ Validé Design par `<nom>` le `YYYY-MM-DD`. Statut → `BUILD`.

---

## 5. Phase BUILD

### 5.1 Branches & PRs

| Branche | Description | PR | Statut |
|---|---|---|---|
| `feat/PRD-XXX-<slug>-api` | Route + service backend | `#42` | `merged` |
| `feat/PRD-XXX-<slug>-mobile` | Écran mobile | `#43` | `review` |
| `feat/PRD-XXX-<slug>-admin` | Page admin | `#44` | `draft` |

### 5.2 Commits clés

> Référencer le PRD dans le message : `feat(missions): ajout notation (PRD-XXX)`

### 5.3 Migration appliquée

- Nom : `<YYYYMMDDHHMM>_<slug>`
- Appliquée en dev : `YYYY-MM-DD`
- Appliquée en recette : `YYYY-MM-DD`
- Backup avant migration recette/preprod : `oui / non + lien`

### 5.4 TODO(debt) introduits

> Tout raccourci pris pendant Build doit être listé ici avec ticket de suivi.

| TODO | Fichier:ligne | Ticket de suivi | Échéance |
|---|---|---|---|
| `TODO(debt): cache en mémoire à remplacer par Redis` | `src/.../service.ts:42` | `#FOLLOWUP-12` | `v1.1` |

### 5.5 Captures d'écran (mobile + admin)

> Avant / Après. Joindre images.

### 5.6 Definition of Done — Build

- [ ] CI verte (typecheck, lint, tests unit + intégration, build Docker)
- [ ] Coverage ≥ 80 % sur services Payment/Escrow/Auth, ≥ 60 % ailleurs
- [ ] Zéro `any`, `console.log`, secret en clair, `JSON.parse(llmResponse)` sans Zod
- [ ] Logger structuré utilisé partout, redactor PII actif
- [ ] Tous les critères d'acceptance ✅
- [ ] OpenAPI à jour (si route API)
- [ ] PR self-reviewed avec checklist
- [ ] TODO(debt) listés ci-dessus avec ticket de suivi
- [ ] **Captures d'écran** jointes

> ✍️ Validé Build par `<nom>` le `YYYY-MM-DD`. Statut → `VERIFY`.

---

## 6. Phase VERIFY

### 6.1 Audit sécurité (5 passes — `reviewer-securite-code`)

**Lien rapport** : `docs/security-reviews/<YYYY-MM-DD>-PRD-XXX.md`

**Synthèse** :

| Sévérité | Compte | Statut |
|---|:-:|---|
| Critical | 0 | doit être 0 pour merger |
| Important | 0 | tous résolus ou ticket de suivi |
| Suggestion | _ | au choix |
| Conforme | _ | OK |

### 6.2 Performance

- [ ] N+1 vérifié (logs Prisma en dev)
- [ ] Indexes DB validés (EXPLAIN ANALYZE sur requête critique)
- [ ] Payloads API < 1 MB (sauf justifié)
- [ ] Images optimisées (Cloudinary `f_auto,q_auto`)

### 6.3 RGPD

- [ ] Logger redactor actif (pas de PII en logs)
- [ ] Rétention photos 12 mois respectée (si applicable)
- [ ] Soft delete user 30j respecté (si applicable)
- [ ] Droit à l'effacement testé

### 6.4 Manual QA (recette)

| Cas testé | Résultat | Testeur | Date |
|---|---|---|---|
| Happy path | ✅ / ❌ | | |
| Cas d'erreur | ✅ / ❌ | | |
| Cas limite | ✅ / ❌ | | |

### 6.5 Smoke test paiement (si applicable)

- [ ] Carte `4242 4242 4242 4242` → succès
- [ ] Carte `4000 0000 0000 3220` → 3DS
- [ ] Carte `4000 0000 0000 9995` → refus
- [ ] Webhook Stripe reçu et traité

### 6.6 Plan de rollback testé

> Décrire ce qui a été fait pour valider le rollback (down migration, feature flag off, redéploiement version précédente).

### 6.7 Métriques instrumentées

- [ ] Events / logs / dashboards qui mesureront les métriques de succès du §1.3 sont en place
- [ ] Lien dashboard : `<lien>`

### 6.8 Definition of Done — Verify (release-ready)

- [ ] Rapport sécu joint, 0 Critical / 0 Important non traité
- [ ] Manual QA recette OK (sign-off humain)
- [ ] Smoke test paiement OK (si applicable)
- [ ] Métriques succès instrumentées
- [ ] Plan de rollback validé
- [ ] Changelog / release note rédigée
- [ ] **Validation humaine finale** (Owner produit + Owner technique)

> ✍️ Validé Verify par `<noms>` le `YYYY-MM-DD`. Statut → `DONE`.

---

## 7. Post-release

### 7.1 Suivi métriques (J+7, J+30)

| Métrique | Cible | J+7 | J+30 | Action si écart |
|---|---|:-:|:-:|---|
| Ex : taux complétion | 80 % | _% | _% | |

### 7.2 Incidents éventuels

> Lien post-mortems et ADRs correctives.

### 7.3 Dette consommée / créée

> Reprise du §5.4 — quels TODO(debt) ont été résolus depuis ? Lesquels restent ?

---

## 8. Annexes

### 8.1 Recherches / benchmarks

> Liens, notes, captures qui ont nourri le design.

### 8.2 Refusés / alternatives non retenues

> Pourquoi telle option n'a pas été choisie. Évite de revenir 6 mois plus tard sur la même discussion.

| Alternative | Pourquoi non retenue |
|---|---|
| ... | ... |

### 8.3 Glossaire

> Termes métier ou techniques spécifiques à cette feature.

---

## 9. Checklist BMAD globale (à cocher avant `DONE`)

- [ ] **Discover** : DoD ✅ + validation humaine
- [ ] **Design** : DoD ✅ + validation humaine
- [ ] **Build** : DoD ✅ + validation humaine
- [ ] **Verify** : DoD ✅ + double validation (produit + technique)
- [ ] PRD archivé, statut `DONE`, version finale taguée

---

*Template PRD Clean Connect v1.0 — méthode [BMAD-light](../method/BMAD.md) — cahier [v1.4](../CAHIER-DES-CHARGES-v1.4.md)*
