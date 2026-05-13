# Decision Record — Clôture Sprint 4 (PRD-004 Hardening, Ops & Compliance)

> **Document unique de clôture Sprint 4.** À conserver dans `docs/sprint-closure/`.
> **Statut courant** : 🟡 `PENDING_OPS_EVIDENCE` — *aucune* étape humaine n'a encore eu lieu.
> **Règle** : ce document ne peut être marqué `SIGNED` que lorsque **toutes** les sections §3 → §7 sont remplies avec des **preuves traçables** (liens, captures, timestamps, signatures réelles).
>
> **Source de vérité opérationnelle** :
> - [PRD-004](../prd/PRD-004-hardening-ops-compliance.md) §4.15
> - [Runbook activation](../runbooks/finance-monitoring-activation.md)
> - [Runbook surveillance 72h](../runbooks/finance-monitoring-72h-surveillance.md)
> - [Playbook incident](../runbooks/finance-monitoring-incident-playbook.md)
> - [Grille Go/No-Go prod](../runbooks/finance-monitoring-go-no-go-prod.md)
> - [Verify final 2026-05-13](../security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md)

---

## 0. Métadonnées

| Champ | Valeur |
|---|---|
| **Sprint** | Sprint 4 |
| **PRD pilote** | PRD-004 — Hardening, Ops & Compliance |
| **Tickets inclus** | 4.1 Sentry/OTel, 4.2 Retry/Recovery BullMQ, 4.3 Admin Tooling UI (subset), 4.4 RGPD avancé, 4.5 Monitoring financier (+ `FIN-ITER2-DEBTS`) |
| **Engineering merged** | PR #29 → `main @ c3cbb06` (2026-05-13) |
| **Doc package merged** | PR #30 → `main @ ???` (à compléter à la fusion) |
| **Discover suivant (PRD-005)** | PR #32 → `main @ ???` (à compléter à la fusion) |
| **Document créé** | 2026-05-13 |
| **Verdict** | ⏳ `PENDING_OPS_EVIDENCE` |
| **Statut PRD-004 visé** | `DONE` (uniquement si verdict §8 = `DONE`) |
| **Owner clôture** | CTO + SRE primaire |
| **Signataires requis** | CTO, DPO, SRE primaire, Reviewer sécu |

> ⚠️ **Aucune valeur fictive** dans ce document. Toute case non remplie reste *vide explicitement*. Pas de simulation, pas d'hypothèse.

---

## 1. Périmètre couvert par Sprint 4

| Élément | État engineering | État opérationnel |
|---|---|---|
| Observability (Sentry + OTel + Grafana + BullBoard + alerting) — Ticket 4.1 | ✅ mergé | activation prod ? **à compléter** |
| Retry / Recovery / DLQ BullMQ — Ticket 4.2 | ✅ mergé | activation prod ? **à compléter** |
| Admin Tooling UI (API endpoints DLQ / finance) — Ticket 4.3 partiel | ✅ mergé (subset API) | UI front = **out of scope Sprint 4** → PRD-005B |
| RGPD avancé — Ticket 4.4 | ✅ mergé (rétention, redactor, soft-delete) | sign-off DPO ? **à compléter** |
| Monitoring financier — Ticket 4.5 + `FIN-ITER2-DEBTS` | ✅ mergé (`FF=false` par défaut) | activation `FF=true` recette ? **à compléter** ; prod ? **à compléter** |

---

## 2. Gates d'entrée (rappel — préalables au présent dossier)

Toutes ces conditions doivent être ✅ avant même de commencer à remplir le présent Decision Record.

- [x] **Engineering READY** : PR #29 squash-mergée sur `main` (commit `c3cbb06`)
- [x] **Verify final engineering** : 0 Critical / 0 Important — [`2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`](../security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md)
- [x] **`FF_FINANCE_MONITORING_ENABLED=false`** par défaut dans `apps/api/src/common/config/env.ts` + `.env.example`
- [x] **Aucune migration Prisma** dans le merge engineering → rollback `FF=false` trivial
- [x] **Runbooks activation + 72h surveillance + incident playbook + Go/No-Go prod** disponibles (PR #30 — `MERGEABLE`, CI verte, **non mergée au moment de la création du présent doc**)
- [x] **Snapshot script** read-only `scripts/finance-monitoring-snapshot.{sh,ps1}` disponible (PR #30)
- [ ] **PR #30 mergée sur `main`** — à confirmer
- [ ] **CTO a lu** le présent Decision Record et accepte son usage comme **document unique** de clôture Sprint 4

> ✍️ Validation préalable CTO : *[nom + date]*

---

## 3. Recette — Activation `FF_FINANCE_MONITORING_ENABLED=true`

> Référence procédure : [`finance-monitoring-activation.md`](../runbooks/finance-monitoring-activation.md) §2.

### 3.1 Méta

| Champ | Valeur |
|---|---|
| Environnement | recette (`cleanconnect-rec`) |
| Date d'activation (UTC) | _YYYY-MM-DDTHH:MM:SSZ_ |
| Date d'activation (Europe/Paris) | _YYYY-MM-DD HH:MM_ |
| SRE primaire | _@…_ |
| SRE secondaire | _@…_ |
| Rolling restart pods | ☐ effectué ; durée _ s |
| Boot logs propres | ☐ vérifiés (lien export ou capture) |
| 6/6 schedulers actifs au boot | ☐ confirmé |
| Queues BullMQ propres | ☐ confirmé |
| Discord `#ops-finance` reçoit alertes test | ☐ confirmé |

### 3.2 Rapport smoke recette

- Fichier exécution réelle : `docs/security-reviews/operational-smoke-rec-YYYY-MM-DD.md` (à créer à partir du [template](../security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md))
- Lien : _à compléter_
- Verdict smoke : ☐ ✅ `READY` / ☐ ⚠️ `RESERVED` / ☐ ❌ `FAILED`
- Sign-off SRE primaire smoke : *[nom + date]*

> 🔒 **Bloque tout passage à §4 tant que verdict smoke ≠ `READY`.**

---

## 4. Recette — Observation 72h sous `FF=true`

> Référence : [`finance-monitoring-72h-surveillance.md`](../runbooks/finance-monitoring-72h-surveillance.md) + [`operational-72h-final-report.md`](../security-reviews/operational-72h-final-report.md).

### 4.1 Checkpoints exécutés

> 7 checkpoints attendus minimum. Lien direct vers chaque fichier `operational-72h-checkpoint-T+<XX>-rec-YYYY-MM-DD.md`.

| Checkpoint | Heure UTC | Verdict | Lien fichier |
|---|---|---|---|
| T+15min | _ | ✅ / ⚠️ / 🚨 | _ |
| T+1h | _ | _ | _ |
| T+4h | _ | _ | _ |
| T+12h | _ | _ | _ |
| T+24h | _ | _ | _ |
| T+48h | _ | _ | _ |
| T+72h | _ | _ | _ |

### 4.2 Rapport final 72h

- Fichier exécution réelle : `docs/security-reviews/operational-72h-final-report-rec-YYYY-MM-DD.md` (à créer à partir du [template](../security-reviews/operational-72h-final-report.md))
- Lien : _à compléter_
- **Verdict §9.3 du rapport** :
  - [ ] ✅ **STABLE — Go prod éligible**
  - [ ] ⚠️ **RÉSERVÉ — Prolonger recette 24h**
  - [ ] ❌ **INSTABLE — Rollback + retour engineering**

### 4.3 Incidents observés sur 72h

| ID | Sévérité | Cause racine résolue | Post-mortem |
|---|---|---|---|
| _aucun_ ou _INC-xxx_ | P0/P1/P2/P3 | ☐ oui / ☐ non | lien |

> Tout P0 non résolu = **No-Go automatique** (cf. §6.2 critère N1).

### 4.4 Rollback testé

- [ ] Rollback réel exécuté lors d'un incident → durée _min (cible < 2 min)
- [ ] *OU* rollback à blanc planifié en fin de fenêtre 72h → durée _min
- Lien preuve (logs / commit message / ticket) : _à compléter_

### 4.5 PII — vérification finale

- [ ] Logs `cc-api` (24h ×3) : `grep -E '(@|sk_(test|live)_|whsec_|Bearer )'` → **0 match hors `[REDACTED]`**
- [ ] Metrics `/internal/metrics` : aucun label PII (`userId=`, `email=`, `paymentId=` brut)
- [ ] `finance_alerts.context` 72h : requête SQL §6 du rapport final → **0 row PII**
- [ ] Daily reports email J-1, J-2, J-3 : sample agrégats uniquement, **aucune PII**
- [ ] Snapshots whitelist `FINANCE_SNAPSHOT_WHITELIST` respectée

Sign-off SRE primaire 72h : *[nom + date]*  
Sign-off Reviewer sécu 72h : *[nom + date]*

---

## 5. DPO — Sign-off Sprint 4

> Référence package DPO : [`docs/dpo/finance-monitoring-rgpd-summary.md`](../dpo/finance-monitoring-rgpd-summary.md).

### 5.1 Réponses aux 5 questions DPO

| # | Question (extrait du package DPO) | Réponse DPO | Date |
|---:|---|---|---|
| 1 | Rétention 90 j `FinanceMismatch` tous statuts confondus est-elle acceptable RGPD ? | ☐ oui / ☐ non / ☐ avec réserve | _ |
| 2 | Rétention 5 ans `FinanceDailyReport` (obligation comptable C. com. L123-22) confirmée ? | ☐ oui / ☐ non | _ |
| 3 | Resend (sous-traitant email) ajouté au registre traitements ? | ☐ oui / ☐ non | _ |
| 4 | Confirmation absence PII dans contextes alertes / metrics / logs / daily emails ? | ☐ oui / ☐ non | _ |
| 5 | Droit d'accès / effacement opérable depuis routes RGPD existantes (`/users/me/export`, `/users/me`) ? | ☐ oui / ☐ non | _ |

### 5.2 Sign-off

- **DPO** : *[nom + date + signature ou référence outil interne]*
- **Réserves** : _à compléter (le cas échéant)_
- **Plan de remédiation** si réserves : _à compléter_

> 🔒 Tant que sign-off DPO non confirmé → **Go/No-Go prod ne peut pas se tenir**.

---

## 6. Réunion Go/No-Go production

> Référence grille : [`finance-monitoring-go-no-go-prod.md`](../runbooks/finance-monitoring-go-no-go-prod.md).

### 6.1 Métadonnées réunion

| Champ | Valeur |
|---|---|
| Date | _YYYY-MM-DD HH:MM Europe/Paris_ |
| Participants | _CTO @… ; DPO @… ; SRE primaire @… ; Reviewer sécu @…_ |
| Lien PV / notes | _à compléter_ |

### 6.2 Critères

#### Go (tous requis ✅)

| # | Critère | OK ? |
|---|---|---|
| G1 | 72h sans P0 finance | ☐ |
| G2 | ≤ 1 P1 expliqué et résolu | ☐ |
| G3 | 0 double payout / 0 double refund | ☐ |
| G4 | 0 fuite PII confirmée | ☐ |
| G5 | Cardinalité Prom ≤ 80 séries sur toute la fenêtre | ☐ |
| G6 | Memory `cc-api` / Redis stables (< +10 %) | ☐ |
| G7 | 6/6 schedulers ont tiré au moins 1× / fenêtre attendue | ☐ |
| G8 | 3/3 daily reports envoyés (J-1, J-2, J-3) | ☐ |
| G9 | Rollback testé (réel ou exercice) < 2 min | ☐ |
| G10 | Tous les checks B/C/D/E du smoke restent ✅ à T+72h | ☐ |

#### No-Go (1 seul = blocage)

| # | Critère | Détecté ? |
|---|---|---|
| N1 | ≥ 1 P0 finance non résolu | ☐ |
| N2 | ≥ 2 P1 inexpliqués cumulés | ☐ |
| N3 | Cardinalité Prom > 80 séries observée (même brièvement) | ☐ |
| N4 | Daily report email absent ou KO sur ≥ 1 jour | ☐ |
| N5 | Memory / Redis growth anormal | ☐ |
| N6 | Session PG bloquée sur advisory lock > 30 s | ☐ |
| N7 | Incident **NOT FOUND** dans runbooks | ☐ |
| N8 | Refus DPO ou CTO | ☐ |

### 6.3 Verdict réunion

- [ ] 🟢 **GO PROD** — activation `FF=true` autorisée
- [ ] 🟡 **HOLD** — prolonger recette ; conditions précises pour relance : _à compléter_
- [ ] 🔴 **NO-GO** — retour engineering ; cause + plan : _à compléter_

Sign-offs réunion :
- CTO : *[nom + date]*
- DPO : *[nom + date]*
- SRE primaire : *[nom + date]*
- Reviewer sécu : *[nom + date]*

---

## 7. Production — Activation `FF_FINANCE_MONITORING_ENABLED=true`

> ⚠️ Cette section ne se remplit **que** si §6.3 = 🟢 GO PROD.

### 7.1 Activation

| Champ | Valeur |
|---|---|
| Fenêtre d'activation cible | _jour ouvré, créneau 10h-12h Europe/Paris_ |
| Date d'activation effective (UTC) | _YYYY-MM-DDTHH:MM:SSZ_ |
| Date d'activation (Europe/Paris) | _YYYY-MM-DD HH:MM_ |
| SRE on-call activation | _@…_ |
| Vault / secret manager : `FF_FINANCE_MONITORING_ENABLED=true` | ☐ poussé |
| Rolling restart `cc-api` prod | ☐ effectué (durée _ s) |
| Boot logs propres | ☐ vérifiés (lien) |
| 6/6 schedulers actifs | ☐ confirmé |
| Premier daily report J+1 envoyé | ☐ confirmé |

### 7.2 Monitoring J+1 / J+7

> Surveillance allégée post-activation. Tout incident ≥ P1 → ouvrir post-mortem + revue d'extension fenêtre.

| Cadence | Date prévue | Verdict | Note |
|---|---|---|---|
| J+1 | _ | ✅ / ⚠️ / 🚨 | _ |
| J+7 | _ | _ | _ |

### 7.3 Plan de communication

- [ ] Slack `#ops-critical` : annonce activation
- [ ] Slack `#engineering` : annonce activation + statut
- [ ] Communication communauté / clients : **inutile** (pas de surface visible utilisateur)
- [ ] PRD-005 §12.2 (gates Design 005A) débloqué — informer Kyria (Owner produit Sprint 5)

---

## 8. Verdict final Sprint 4

> Cocher **un seul** verdict après que §3 → §7 soient remplis intégralement avec preuves.

- [ ] ✅ **`DONE`** — toutes étapes traçables, `FF=true` actif en production, J+1/J+7 stables, statut PRD-004 → `DONE`, tag release à émettre
- [ ] 🟡 **`READY_WITH_DEBT`** — `FF=true` actif en prod mais ≥ 1 réserve ouverte (préciser ci-dessous) ; statut PRD-004 → `DONE_WITH_DEBT`
- [ ] 🟠 **`HOLD_RECETTE`** — recette prolongée ou nouvelle fenêtre 72h requise ; statut PRD-004 reste `BUILD_DONE_PENDING_VERIFY_OPS`
- [ ] 🔴 **`BLOCKED`** — retour engineering (nouvelle itération PRD-004 ou bugfix dédié) ; statut PRD-004 → `BLOCKED`

### Réserves / dettes ouvertes acceptées

| ID | Description | Échéance | Ticket de suivi |
|---|---|---|---|
| _ | _ | _ | _ |

### Sign-offs finaux Sprint 4

| Rôle | Nom | Date | Signature / référence |
|---|---|---|---|
| CTO | _ | _ | _ |
| DPO | _ | _ | _ |
| SRE primaire | _ | _ | _ |
| Reviewer sécu | _ | _ | _ |

---

## 9. Conséquences en aval

### 9.1 Mise à jour PRD-004

À effectuer **uniquement** si verdict §8 = `DONE` ou `READY_WITH_DEBT` :

- [ ] PRD-004 §0 (méta) : statut → `DONE` (ou `DONE_WITH_DEBT`)
- [ ] PRD-004 §4.15.17 : marquer `FIN-ITER2-DEBTS` *closes en production*
- [ ] `docs/prd/README.md` : ligne PRD-004 → statut final
- [ ] CHANGELOG : entrée `Released > Sprint 4 DONE — date`
- [ ] Tag Git : à définir (ex. `v0.4.0-hardening-ops-compliance`)

### 9.2 Déblocage PRD-005

Si Sprint 4 = `DONE` ou `READY_WITH_DEBT`, gate G1/G2 de PRD-005 §12.2 sont franchies pour **`PRD-005A — Mobile Core UX`** :

- Gate §12.2 G1 (Sprint 4 clos) : ☐ ✅
- Gate §12.2 G2 (`FF=true` prod stable) : ☐ ✅
- Gate §12.2 G3 (observation runtime validée) : ☐ ✅
- Gate §12.2 G4 (rollback testé) : ☐ ✅
- Gate §12.2 G5 (DPO sign-off) : ☐ ✅
- Gate §12.2 G6 (CTO sign-off) : ☐ ✅

→ Ouverture officielle Design 005A possible (séparée, hors présent dossier).

### 9.3 Si verdict = `HOLD_RECETTE` ou `BLOCKED`

- Conserver le présent Decision Record en `PENDING_OPS_EVIDENCE`
- Documenter la cause + plan dans §8 « Réserves / dettes ouvertes »
- Ouvrir post-mortem si incident origine de blocage
- Re-déclencher §4 ou §5 ou §6 après remédiation

---

## 10. Annexe — Chaîne de preuves attendue

Pour chaque section §3 à §7, **fichier(s) source** à conserver dans le dépôt (ou liens externes traçables si confidentiels).

| Section | Fichier / preuve attendue | Présent ? |
|---|---|---|
| §3 | `docs/security-reviews/operational-smoke-rec-YYYY-MM-DD.md` | ☐ |
| §4 | `docs/security-reviews/operational-72h-checkpoint-T+*-rec-YYYY-MM-DD.md` (≥7) | ☐ |
| §4 | `docs/security-reviews/operational-72h-final-report-rec-YYYY-MM-DD.md` | ☐ |
| §5 | Email/outil interne DPO sign-off (référence) | ☐ |
| §6 | PV réunion Go/No-Go (Slack thread / Notion / doc) | ☐ |
| §7 | Commit message ou ticket d'activation prod | ☐ |
| §7 | Captures Grafana J+1 / J+7 | ☐ |
| §8 | Tag Git release | ☐ |

---

*Decision Record produit le 2026-05-13. À blanc. Aucune valeur opérationnelle n'a été supposée ou inventée. Toute valeur ci-dessus = « _ », ☐, ou « à compléter » correspond à un acte humain non réalisé au moment de la création.*
