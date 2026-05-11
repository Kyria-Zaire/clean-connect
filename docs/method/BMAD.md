# BMAD-light — Méthode de delivery Clean Connect

> **BMAD** = *Build with Method, AI-Driven*
> Version adaptée à Clean Connect. 4 phases. Chaque phase a un pilote, des deliverables exigés, une Definition of Done (DoD), et un mapping explicite vers nos personas (`.cursor/rules/`) et nos skills (`.cursor/skills/`).
>
> **Objectif** : zéro feature ne quitte une phase sans son artefact validé. Pas de "on verra à l'implémentation".

---

## 0. Pourquoi BMAD-light ?

| Problème classique | Réponse BMAD-light |
|---|---|
| L'IA code avant d'avoir compris le besoin | Phase **Discover** obligatoire avant tout commit |
| Pas de contrat clair entre back / mobile / admin | Phase **Design** produit les schémas Zod, OpenAPI, types partagés |
| Code mergé sans relecture sécu | Phase **Verify** avec `reviewer-securite-code` en gate dur |
| Dette technique invisible | Chaque PR référence un PRD ; chaque PRD trace ses TODO(debt) |
| Régression de scope | `Definition of Done` figée à la fin de Design, non modifiable en Build |

---

## 1. Les 4 phases

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  DISCOVER  │ →  │   DESIGN   │ →  │    BUILD   │ →  │   VERIFY   │
│  (besoin)  │    │ (contrats) │    │ (code +    │    │ (sécu,     │
│            │    │            │    │  tests)    │    │  perf, DoD)│
└────────────┘    └────────────┘    └────────────┘    └────────────┘
     ↑                                                       │
     └───────────────── feedback / nouveau cycle ────────────┘
```

Chaque phase produit **un artefact obligatoire** vérifié en début de phase suivante.

---

## 2. Phase DISCOVER — Cadrer le besoin

### Pilote
**`senior-dev`** (posture transverse) + un référent métier humain.

### Objectif
Transformer une demande floue ("ajouter un système de notation") en un **PRD feature** chiffré, scoré, priorisé, lié au cahier v1.4.

### Inputs
- Demande utilisateur ou ticket
- Cahier des charges v1.4 (`docs/CAHIER-DES-CHARGES-v1.4.md`)
- Métriques business actuelles (si feature d'amélioration)

### Activités
1. **Reformulation du besoin** en 1 phrase ("En tant que X, je veux Y pour Z").
2. **Cartographie d'impact** : modules touchés (API, mobile, admin, DB, paiement, RGPD).
3. **Risk assessment rapide** :
   - Risque sécurité (1-5)
   - Risque RGPD (1-5)
   - Risque financier (1-5)
   - Risque UX (1-5)
4. **Définition du scope MVP** vs *nice to have* (cut clair).
5. **Open questions** listées et résolues avec le porteur (pas de "on verra plus tard").

### Output obligatoire
**Un fichier `docs/prd/<feature-slug>.md`** rempli à partir de `docs/templates/PRD-template.md`.

### Definition of Done — Discover
- [ ] PRD instancié avec ID, version, statut `DRAFT`
- [ ] Lien direct vers la section du cahier v1.4 concernée
- [ ] Au moins 1 user story formulée avec critères d'acceptance testables
- [ ] Scores risques renseignés (≥ 4 sur sécu/RGPD/finance → revue obligatoire en Design)
- [ ] Section "Open questions" vidée (toutes résolues)
- [ ] Estimation grossière en jours-homme (T-shirt size : XS / S / M / L / XL)
- [ ] **Validation humaine explicite** sur le PRD avant passage en Design

### Anti-patterns
- ❌ Démarrer Design sans PRD validé
- ❌ "On précisera les critères d'acceptance plus tard"
- ❌ PRD écrit après le code (rétro-justification)

---

## 3. Phase DESIGN — Figer les contrats

### Pilote
- **Backend** : `architecte-api`
- **Frontend (mobile + admin)** : `seniordev-frontend`
- **Infra / cross-cutting** : `ingenieur`

### Objectif
Produire les **contrats techniques** que l'implémentation suivra **sans dévier**. Un Build qui dévie du Design = bug à corriger côté Design d'abord.

### Inputs
- PRD validé (sortie de Discover)
- Schéma DB actuel (`apps/api/prisma/schema.prisma`)
- Conventions projet (rules `architecte-api`, `backend`, `mobile`, `seniordev-frontend`)

### Activités
1. **Modélisation Prisma** : tables, relations, index, contraintes, migration name. Vérifier les indexes GIST si géo.
2. **Schémas Zod partagés** : générés via `zod-prisma-types` puis étendus dans `packages/shared-types`.
3. **Contrat API** : routes, méthodes, request/response Zod, codes HTTP, idempotence, rate limit. OpenAPI auto-généré via `nestjs-zod`.
4. **Contrat UI** : wireframes ou maquettes Figma, states (loading / empty / error / success), accessibilité (a11y AA), tokens NativeWind / shadcn utilisés.
5. **Effets de bord** : jobs BullMQ, emails, push FCM, webhooks Stripe, écritures DB asynchrones.
6. **Stratégie de tests** : ce qui sera testé en unitaire, intégration, E2E (Detox), revue sécu.
7. **Plan de rollout** : feature flag ? migration data ? backward compat ?
8. **Decision Records** : pour tout choix non-trivial (`docs/adr/ADR-<n>-<sujet>.md`).

### Outputs obligatoires
- [ ] PRD mis à jour, statut `DESIGN_REVIEW`
- [ ] Section **"Contrats techniques"** du PRD remplie (lien Prisma, Zod, OpenAPI snippet, UI states)
- [ ] ADR créé si décision structurante
- [ ] Plan de tests rédigé dans le PRD

### Definition of Done — Design
- [ ] Schéma Prisma proposé (pas encore migré)
- [ ] Schémas Zod proposés (pas encore mergés)
- [ ] Routes API listées avec verbes + codes HTTP + idempotence/rate limit
- [ ] UI states couverts (loading / empty / error / success / offline)
- [ ] Plan de tests explicite (quel test pour quel critère d'acceptance)
- [ ] Risques sécu/RGPD ≥ 4 → check pré-revue par `reviewer-securite-code` (lecture, pas encore audit)
- [ ] **Validation humaine explicite** sur les contrats avant passage en Build

### Skills à invoquer
- `create-nestjs-endpoint` (squelette route)
- `prisma-migration-workflow` (préparer la migration)
- `integrate-external-service` (si dépendance Stripe, Cloudinary, FCM, etc.)
- `stripe-escrow-flow` (si touche au paiement)

### Anti-patterns
- ❌ Coder l'API avant d'avoir figé le schéma Zod
- ❌ Designer l'UI mobile sans aligner avec les contrats API
- ❌ Skipper l'ADR sur un choix structurant ("on verra")

---

## 4. Phase BUILD — Implémenter

### Pilote (selon scope)
- Backend → `architecte-api` + `backend`
- Mobile → `mobile` + `seniordev-frontend`
- Admin → `seniordev-frontend`
- Infra → `ingenieur` + `createur-workflow`

Toujours en posture `senior-dev` (transverse).

### Objectif
Écrire le code qui respecte **exactement** les contrats de Design. Toute déviation revient en Design.

### Règles d'or
1. **Une PR = un scope du PRD** (idéalement 1 user story, max 1 epic).
2. **Branch naming** : `feat/<prd-id>-<slug>` / `fix/<prd-id>-<slug>` / `chore/<slug>`.
3. **Commits** : Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). Référencer le PRD : `feat(missions): cr\u00e9ation route POST /missions (PRD-007)`.
4. **TDD ou test-first quand sécu/argent** : payment, escrow, auth, RGPD.
5. **`TODO(debt):`** systématique si raccourci pris — jamais de raccourci silencieux.
6. **Pas de fetch manuel** vers l'API : utiliser le client TanStack Query généré.
7. **Pas de `any`, pas de `console.log`, pas de SQL raw non justifié** (rule `senior-dev`).

### Outputs obligatoires
- [ ] PR ouverte avec template (cf. `.github/PULL_REQUEST_TEMPLATE.md`)
- [ ] Lien PRD dans la description PR
- [ ] Tests verts (typecheck + lint + unit + intégration)
- [ ] Migration Prisma générée et reviewée (jamais `db push` en prod)
- [ ] Captures d'écran UI mobile/admin (avant/après)
- [ ] Section **"Implémentation"** du PRD remplie (commits ou PR liés)

### Definition of Done — Build (PR mergeable)
- [ ] CI verte (typecheck, lint, tests, build Docker)
- [ ] Coverage minimum : 80 % sur services Payment / Escrow / Auth, 60 % ailleurs
- [ ] Pas de `// FIXME`, `console.log`, `any`, secret en clair, `JSON.parse(llmResponse)` sans Zod
- [ ] Logger structuré utilisé partout, redactor PII actif
- [ ] Critères d'acceptance du PRD ✅ tous cochés
- [ ] Documentation OpenAPI à jour (si route API)
- [ ] PR auto-review : l'auteur passe en revue son propre diff avec checklist

### Skills à invoquer
- `create-nestjs-endpoint`, `prisma-migration-workflow`, `stripe-escrow-flow`, `offline-sync-pattern`, `integrate-external-service`, `deploy-environment`

### Anti-patterns
- ❌ Merger une PR sans test pour le critère d'acceptance
- ❌ Refactor non scopé glissé dans une PR feature
- ❌ "Je commit, je verrai pour les tests demain"

---

## 5. Phase VERIFY — Sécuriser et valider

### Pilote
- **Sécurité** : `reviewer-securite-code` (audit 5 passes)
- **Qualité produit** : `senior-dev` + validation humaine (QA / PO)

### Objectif
Garantir que la PR est non seulement *fonctionnelle*, mais aussi **sûre, performante, conforme RGPD et auditable**.

### Activités
1. **Audit sécurité 5 passes** par `reviewer-securite-code` :
   1. Inputs (validation Zod, rate limit, taille body)
   2. Trust (auth, RBAC, ownership, secrets)
   3. Flow (idempotence, transactions, atomicité, webhooks signés)
   4. Errors (pas de stack trace exposée, logs sans PII, fallback)
   5. Mass production (réutilisation correcte des helpers, pas de duplication critique)
2. **Performance** : N+1 queries, indexes manquants, payloads > 1 MB, images non optimisées.
3. **RGPD** : logger redactor actif, photos avec rétention 12 mois, soft delete users 30j, droit à l'effacement.
4. **Tests E2E Detox** (mobile) sur happy path si touché.
5. **Manual QA** (validation humaine) sur l'env de **recette**.
6. **Smoke test paiement** si touche au flow Stripe (carte 4242 + 4000…3220 3DS + 4000…9995 refus).

### Outputs obligatoires
- [ ] Rapport de revue sécu au format `reviewer-securite-code` (Critical / Important / Suggestion / Conforme)
- [ ] **Aucun item Critical non résolu** → merge bloqué
- [ ] Items Important : soit résolus, soit transformés en `TODO(debt):` avec ticket de suivi
- [ ] Section **"Validation"** du PRD remplie (lien rapport, date, validateur humain)
- [ ] PRD passé en statut `DONE`
- [ ] Tag de release ou note de changelog ajoutée

### Definition of Done — Verify (release-ready)
- [ ] Rapport sécu joint, niveaux Critical/Important à zéro
- [ ] Manual QA OK sur recette (signature humaine dans le PRD)
- [ ] Smoke test paiement OK si applicable
- [ ] Métriques de succès du PRD instrumentées (logs, dashboards)
- [ ] Plan de rollback testé si déploiement à risque
- [ ] PRD statut `DONE` + archivage

### Skills à invoquer
- `review-security-route`
- `deploy-environment` (déploiement recette → preprod → prod)

### Anti-patterns
- ❌ Considérer "tests verts" = "feature validée"
- ❌ Skipper le manual QA parce que "c'est petit"
- ❌ Promouvoir en prod sans passage en preprod

---

## 6. Matrice persona × phase

|                          | Discover | Design | Build | Verify |
|--------------------------|:-:|:-:|:-:|:-:|
| `senior-dev`             | 🟢 pilote | 🟢 garde-fou | 🟢 actif | 🟢 actif |
| `architecte-api`         | — | 🟢 pilote BE | 🟢 actif BE | — |
| `backend`                | — | 🟢 consulté | 🟢 actif | — |
| `ingenieur`              | — | 🟢 si cross-cutting | 🟢 si infra | — |
| `securite`               | 🟢 risques | 🟢 menaces | 🟢 garde-fou | 🟢 audit |
| `stripe`                 | 🟢 si paiement | 🟢 si paiement | 🟢 si paiement | 🟢 si paiement |
| `photos-rgpd`            | 🟢 si photos | 🟢 si photos | 🟢 si photos | 🟢 si photos |
| `mobile`                 | — | 🟢 pilote mobile | 🟢 actif mobile | — |
| `seniordev-frontend`     | — | 🟢 pilote FE | 🟢 actif FE | — |
| `reviewer-securite-code` | — | 🟢 pré-revue si risque ≥ 4 | — | 🟢 **pilote audit** |
| `createur-workflow`      | — | — | 🟢 si CI/Docker | 🟢 si déploiement |

🟢 = obligatoire — — = optionnel selon scope.

---

## 7. Cadence et rituels

| Rituel | Fréquence | Output |
|---|---|---|
| **Discover review** | Avant chaque feature | PRD validé (humain) |
| **Design review** | Fin de Design | Contrats figés, ADR éventuelle |
| **PR review** | Continue (Build) | Merge ou demande de changement |
| **Security audit** | Fin de Build (Verify) | Rapport `reviewer-securite-code` |
| **Manual QA** | Avant promotion preprod → prod | Sign-off humain |
| **Post-mortem** | Si incident en prod | ADR + ticket de fix |

---

## 8. Liens vers les artefacts

- **Cahier des charges** : `docs/CAHIER-DES-CHARGES-v1.4.md`
- **Template PRD** : `docs/templates/PRD-template.md`
- **PRDs actifs** : `docs/prd/*.md`
- **ADRs** : `docs/adr/ADR-*.md`
- **Rules personas** : `.cursor/rules/*.mdc` (et `.claude/rules/*.md`)
- **Skills workflows** : `.cursor/skills/*/SKILL.md` (et `.claude/skills/*/SKILL.md`)

---

## 9. Métriques de la méthode (à instrumenter en Phase 2)

| Métrique | Cible |
|---|---|
| % features avec PRD complet avant code | 100 % |
| % PR avec rapport sécu attaché | 100 % sur scope sécu/argent |
| Cycle time Discover → Verify (feature M) | < 10 jours |
| Items `Critical` détectés en Verify | objectif → 0 (sinon, problème en Design) |
| TODO(debt) ouverts / fermés par sprint | ratio fermeture > création |

---

## 10. Cas dégradé : urgence prod (hotfix)

```
Hotfix ≠ skip BMAD. Hotfix = BMAD compressé.
```

| Phase | Durée cible hotfix |
|---|---|
| Discover express | 15 min (1 user story, 1 critère, root cause) |
| Design express | 30 min (1 schéma changé max, contrat API stable) |
| Build | 1-2 h (test du critère + non-régression) |
| Verify | 30 min (`reviewer-securite-code` ciblé + smoke prod) |

**Règle** : aucun hotfix ne saute la phase Verify. Jamais.

---

*Clean Connect — méthode BMAD-light v1.0 — alignée Cahier v1.4*
