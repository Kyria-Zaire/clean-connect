# Pré-revue sécurité — Design PRD-004 Ticket 4.5 (Monitoring financier)

| Champ | Valeur |
|---|---|
| **Date** | 2026-05-12 |
| **Reviewer** | `securite` + `reviewer-securite-code` (méthode pré-revue Design — risque Discover Financier 4/5, RGPD 5/5) |
| **PRD** | [`docs/prd/PRD-004-hardening-ops-compliance.md`](../prd/PRD-004-hardening-ops-compliance.md) (Ticket 4.5) |
| **Périmètre** | ADR-018 (Financial monitoring & reconciliation) + PRD-004 §4.15 + runbook `docs/ops/finance-reconciliation-runbook.md` |
| **Statut** | **Pré-revue Design OK — Build interdit sans sign-off CTO Design final et résolution OQ-10..OQ-16.** |

---

## Synthèse

| Sévérité | Compte | Commentaire |
|---|---:|---|
| 🔴 Critical | **0** | — |
| 🟠 Important | **0** (5 **Conditions Build** documentées §3) | — |
| 🟡 Suggestion | **6** | Voir §4 |
| 🟢 Conforme | **17** | Voir §2 |

**Verdict** : aucun blocage **Critical** / **Important** sur le périmètre Design (ADR + contrats + RBAC + redaction + invariants). Les 5 Conditions Build §3 sont des garde-fous **obligatoires** à appliquer en Build du Ticket 4.5 — déjà tracés dans la DoD Build du PRD §4.15.14. Build peut démarrer après sign-off CTO + arbitrage formel des OQ-10..OQ-16.

---

## 1. Méthodologie

**Cibles auditées** :
- `docs/adr/ADR-018-financial-monitoring-reconciliation.md` — architecture monitoring + persistance + alerts + sécurité.
- `docs/prd/PRD-004-hardening-ops-compliance.md` §4.15 — vision, US raffinées, invariants, metrics, alerts, non-goals, OQ-10..OQ-16, modules Nest, risk assessment Design.
- `docs/ops/finance-reconciliation-runbook.md` — procédures investigation + actions admin + escalade.

**Grille d'audit** :
- Checklist `reviewer-securite-code.mdc` (PII, RBAC, audit, idempotence).
- Règle `securite.mdc` (paiements + alertes + logs).
- `CLAUDE.md` (sécurité absolue) + ADR-016 (logging redaction) + ADR-017 (alerting strategy).
- Risques Discover Financier 4/5, RGPD 5/5 (PRD-004 §3.1).

**Tests effectués** (statiques — pas de code à exécuter) :
- ✅ Vérification cohérence ADR-018 ↔ PRD §4.15 ↔ runbook (pas de divergence).
- ✅ Croisement liste métriques `cleanconnect_finance_*` avec labels CTO interdits (PII, IDs).
- ✅ Vérification absence de payload Stripe brut dans `FinanceMismatch.snapshot` (whitelist explicite).
- ✅ Vérification RBAC sur tous les endpoints admin `/v1/admin/finance/*` (ADMIN minimum, audit MissionEvent).
- ✅ Vérification cooldown alerts (anti spam — ADR-017 réutilisé).
- ✅ Vérification rétention `FinanceMismatch` 90 j / `FinanceDailyReport` 5 ans (RGPD + comptable).
- ✅ Vérification "pas de correction automatique destructive MVP" (ADR-018 §2.6).

---

## 2. Checklist conforme (17 items)

### 2.1 Frontière Stripe ↔ DB (ADR-018 §2.1)

1. **Stripe = vérité externe, DB = vérité opérationnelle** : principes P1/P2 figés. Aucune correction silencieuse. Toute mutation passe par un endpoint admin tracé.
2. **Reconciliation read-only** : aucun job ne modifie Stripe ni l'état métier DB. Détecte → persiste → alerte → laisse l'admin décider.
3. **Pas de correction automatique destructive** (P3 + P6) : interdit explicitement au MVP. Réévaluation T+90 j via ADR-019 si patterns reproductibles.
4. **Cas `DISPUTE_OPEN` ignoré** : la reconciliation skip volontairement ces missions (le décalage est intentionnel — PRD-003 ADR-008). Filtrage `WHERE Mission.status != 'DISPUTE_OPEN'` obligatoire en Build.

### 2.2 Cardinalité métriques + PII (ADR-018 §4 + PRD §4.15.6)

5. **Labels métriques whitelistés** : `type`, `severity`, `status`, `kind`, `invariant`, `report_date_offset`. **Aucun ID** (jobId, missionId, paymentId, transferId, refundId, stripeId), **aucun email**, **aucun phone**.
6. **Cardinalité totale bornée** : 65 séries Prometheus pour les 12 métriques `cleanconnect_finance_*`. < 1 % du budget Prometheus actuel. Pas de risque saturation.
7. **`stripeId` tronqué 24 chars** en logs et alertes (cohérent avec `transferIdShort` Ticket 4.2). Forme complète seulement en DB + UI admin.

### 2.3 Persistance + snapshots PII-safe (ADR-018 §2.4 + §4.1)

8. **`FinanceMismatch.dbSnapshot` / `stripeSnapshot`** : whitelist explicite (DB : `id, status, amountCents, currency, idempotencyKey, createdAt, updatedAt` ; Stripe : `id, status, amount, currency, created`). Tout reste passé par `sanitizeForFinanceSnapshot` → `deepSanitize` (ADR-016) anti-fuite.
9. **`FinanceReconciliationRun.triggeredBy`** : `'cron'` ou `adminUserId` UUID — pseudonyme conforme CNIL (cf. ADR-016 §2.7).
10. **Pas de `card.number`, `cvv`, `IBAN`, `BIC`** stockés dans aucune table `Finance*`. Whitelist Build interdit ces clés.

### 2.4 RBAC + audit endpoints admin (ADR-018 §4.4 + PRD §4.15.10 OQ-13)

11. **`GET /v1/admin/finance/*` = `RolesGuard(ADMIN)`** strict. CLIENT / PRESTATAIRE → 401/403.
12. **Mutations = `RolesGuard(ADMIN)` + `reason ≥ 16 chars` + `MissionEvent` audit** (`actorUserId`, `actorEmail` ?, `reason`, `kind`).
13. **Rate-limit 1 run/heure** sur `POST /v1/admin/finance/runs/manual` (anti-spam ; un humain ne devrait jamais en avoir besoin > 1×/heure).

### 2.5 Alerting (ADR-018 §4.3 + PRD §4.15.7)

14. **`AlertingService.emit` réutilisé** : passe par `sanitizeForAlert` (ADR-017 — `deepSanitize` + `redactSecretsInString`). Cooldown 15 min/`mismatchType` ou 1 h/`ressource` selon alert.
15. **Discord embed minimal** : `mismatchId`, `runId`, `resourceKind`, `mismatchType`, `severity`, `amountDeltaCents`, `stripeIdTruncated` (24 chars). **JAMAIS** email/phone/full ID.

### 2.6 Quota Stripe + circuit-breaker (ADR-018 §2.1 P7)

16. **`p-limit(25 req/s)`** sur reconciliation `retrieve`. Stripe limit = 100 req/s par account → 75 % de marge runtime préservée.
17. **`AbortSignal.timeout(5_000 ms)`** sur chaque `retrieve` Stripe. Échec timeout → row reconcile `FAILED` + alerte P1 `finance_reconcile_failed` + retry au prochain cron (24 h).

---

## 3. Conditions Build (obligatoires — non-bloquantes Design)

> 5 conditions à implémenter et tester en Build Ticket 4.5, sous peine de blocage Verify.

### Condition Build 1 — `sanitizeForFinanceSnapshot` fuzz test

**Quoi** : `apps/api/test/unit/sanitize-finance-snapshot.spec.ts` doit faire un fuzz test sur 100+ payloads contenant **volontairement** des PII (emails, cards, phones, addresses) → vérifier que le snapshot émis ne contient **aucune** clé en dehors de la whitelist.

**Pourquoi** : un snapshot mal sanitizé = fuite PII dans `FinanceMismatch` (persistance longue durée). Test fuzz détecte avant prod.

**Cas de test minimum** :
- Payload Stripe `payment_intent` complet (avec `customer`, `charges.data[].billing_details`, etc.) → snapshot ne contient que `{id, status, amount, currency, created}`.
- Payload Stripe `transfer` avec `destination_payment.metadata` → snapshot strip `destination_payment.metadata`.
- Payload DB `Payment` avec relation `mission.address` populée → snapshot strip `mission.address`.

### Condition Build 2 — RBAC test integration `/v1/admin/finance/*`

**Quoi** : `apps/api/test/integration/admin-finance-rbac.integration.spec.ts` couvre :
- CLIENT auth → 403 sur tous les endpoints `/v1/admin/finance/*`.
- PRESTATAIRE auth → 403.
- ADMIN auth → 200 sur GET, 200 sur PATCH avec `reason ≥ 16`.
- ADMIN auth + `reason < 16 chars` → 400 (validation Zod).
- Anonymous → 401.
- ADMIN auth + rate-limit dépassé sur manual run → 429.

**Pourquoi** : RBAC strict évite l'escalade de privilège (CLIENT qui appellerait `/v1/admin/finance/mismatches` pour voir des UUID internes).

### Condition Build 3 — Audit `MissionEvent` sur toute mutation

**Quoi** : `apps/api/test/integration/finance-audit.integration.spec.ts` vérifie qu'un PATCH `/v1/admin/finance/mismatches/:id/resolve` crée une row `MissionEvent` avec :
- `type = 'FINANCE_MISMATCH_RESOLVED'` (ou nouvelle enum à figer Build),
- `actorUserId = <adminUserId>`,
- `payload.mismatchId = <id>`,
- `payload.reason = <reason>` (redacté si > N chars pour limiter taille).

**Pourquoi** : sans audit, un admin compromis pourrait masquer un trou comptable en marquant tous les mismatchs `IGNORED` sans traçabilité.

### Condition Build 4 — Sanity test cooldown alerts finance

**Quoi** : `apps/api/test/unit/finance-alerting-cooldown.spec.ts` :
- 100 mismatchs `STATUS` détectés en 5 min → max 1 alerte Discord émise (cooldown 15 min).
- 1 mismatch `STATUS` puis 1 mismatch `AMOUNT` → 2 alertes (cooldown par `kind`).
- `finance_invariant_break` cooldown 1 h → max 24 alertes/jour.

**Pourquoi** : un incident systémique (ex. Stripe API down 1 h) peut générer 100s de mismatchs. Sans cooldown, le webhook Discord est rate-limité (429) ET les ops sont submergés.

### Condition Build 5 — RGPD rétention + purge cron

**Quoi** : test intégration `finance-retention.integration.spec.ts` :
- Crée `FinanceMismatch` daté > 90 j avec `status = RESOLVED` → purge cron supprime.
- Crée `FinanceMismatch` daté > 90 j avec `status = OPEN` → purge cron **n'efface PAS**.
- Crée `FinanceDailyReport` daté > 5 ans → purge cron supprime (en Verify Ticket 4.4 RGPD).

**Pourquoi** : rétention disciplinée évite l'accumulation infinie (RGPD minimisation + coût stockage). DPO doit valider 90 j en Verify.

---

## 4. Suggestions (6 — non bloquantes)

### Suggestion 1 — Encrypt `FinanceMismatch.stripeId` application-side ?

`stripeId` est un identifiant non-secret (visible côté Stripe Dashboard, logs Stripe). On ne le chiffre pas. **Conforme** ADR-018 §4.2.

Mais : en cas de **dump DB partagé en debug**, un `pi_xxx` peut permettre à un attaquant de **request Stripe** s'il a obtenu un `STRIPE_SECRET_KEY` leaky. Mitigation déjà en place (logger redaction + secret manager).

→ Suggestion : audit hebdomadaire des accès admin DB (cron Sentry / cloud log) — hors scope Ticket 4.5.

### Suggestion 2 — Ajouter `FinanceMismatchAction` audit log

Au lieu de l'enum `MissionEvent` enrichie, créer une table dédiée `FinanceMismatchAction` (1 row par action sur un `FinanceMismatch`) :
```
id, mismatchId (FK), actorUserId, actionType (RESOLVE | IGNORE | INVESTIGATE), reason, performedAt
```

**Avantage** : séparation des audits métier (`MissionEvent`) et audits finance (`FinanceMismatchAction`). Recherche plus rapide.

**Décision** : à arbitrer Build. La simplicité de réutiliser `MissionEvent` (déjà testé/auditable) l'emporte probablement.

### Suggestion 3 — Métrique `cleanconnect_finance_stripe_quota_used`

Suivre la consommation Stripe API quota (`X-RateLimit-Remaining` header) côté `StripeRetrieveService`. Permet d'anticiper la saturation avant qu'elle ne survienne.

**Justif** : si Clean Connect dépasse 5 % de quota, c'est un signal pour repenser le rate-limit ou paginer.

### Suggestion 4 — Embed Discord finance avec deep-link

Quand l'embed Discord pointe vers `/admin/finance/mismatches/:id` (UI Ticket 4.3 à venir), inclure un **deep-link** `https://admin.cleanconnect.fr/finance/mismatches/<id>` dans le champ "Link" de l'embed. Permet aux ops de cliquer directement sans copier-coller.

**Justif** : MTTR -50 % sur une investigation simple.

### Suggestion 5 — Mode "dry-run" pour reconcile en pré-prod

Ajouter un flag env `FINANCE_DRY_RUN=true` qui :
- exécute toute la logique reconcile,
- ne persiste **pas** les `FinanceMismatch`,
- log un résumé "would have created N mismatchs".

**Justif** : utile pour valider les changements de seuils en recette sans polluer la DB.

### Suggestion 6 — Test charge cron sur fixture 10 000 Payment

Avant déploiement prod, faire un test de charge `FinanceReconcileScheduler` sur 10 000 `Payment` + 10 000 `Transfer` + 5 000 `Refund` (volumes PRD-005 estimés).

**Cible** : runtime < 10 min, < 30 % quota Stripe sur la fenêtre.

**Justif** : la reconciliation pourrait devenir un point de contention au scale ; à mesurer maintenant.

---

## 5. Risk matrix Design (Ticket 4.5)

| Domaine | Score | Statut | Mitigation principale |
|---|:-:|:-:|---|
| **Financier** | 4/5 | ✅ mitigé | Read-only, P6 (pas de correction destructive), audit MissionEvent, invariants J-1, rétention longue |
| **RGPD** | 5/5 | ✅ mitigé (Condition Build 1 + 5 obligatoires) | `sanitizeForFinanceSnapshot` + rétention 90 j RESOLVED + DPO valide en Verify |
| **Sécurité (RBAC)** | 4/5 | ✅ mitigé (Condition Build 2) | RBAC ADMIN + rate-limit + audit + tests integration |
| **Surface attaquable** | 3/5 | ✅ mitigé | Pas de webhook externe ouvert, pas d'endpoint public, tout est admin authentifié |
| **Quota Stripe** | 2/5 | ✅ mitigé | p-limit(25) + timeout 5s + circuit-breaker à câbler Build |
| **Alert fatigue** | 3/5 | ✅ mitigé (Condition Build 4) | Cooldown 15 min - 4 h selon alert + batch P2 |
| **Disponibilité dépendance Stripe** | 3/5 | ✅ mitigé | Reconcile failed = alerte + retry 24 h (pas de crash) |
| **Coût** | 1/5 | ✅ acceptable | < 1 % quota Stripe + Discord embed minimaliste |

---

## 6. Recommandations transverses

### 6.1 Boundary stricte avec Ticket 4.2

Ticket 4.5 ne **doit pas** dupliquer la logique de retry transfer (4.2). La frontière :
- 4.2 : retry **mécanique** des jobs BullMQ. S'arrête quand le job est en DLQ ou en succès.
- 4.5 : monitoring **résultat** financier. Ne touche pas à BullMQ. Lit Stripe + DB.

Tout chevauchement = bug d'architecture → refus PR.

### 6.2 Compatibilité PRD-005 Disputes

PRD-005 introduira des disputes Stripe (chargeback). Le `Mission.status = DISPUTE_OPEN` est déjà filtré par la reconciliation. **Aucune adaptation requise** lors de l'arrivée de PRD-005.

### 6.3 Documentation runbook continue

Le runbook actuel (`docs/ops/finance-reconciliation-runbook.md`) est en version **Design** — théorique. Mettre à jour Build **dès la première semaine de prod** avec :
- vrais SQL exécutés (au lieu d'exemples),
- vrais admin endpoints (au lieu de placeholders).

### 6.4 Synergies avec audit comptable

Le `FinanceDailyReport` 5 ans + `FinanceMismatch.resolutionNote` 90 j fournissent une **piste d'audit** suffisante pour un comptable externe. Hors scope MVP mais utile à signaler à l'expert-comptable Clean Connect.

---

## 7. Verdict final pré-revue Design

✅ **Design Ticket 4.5 — validé** sous réserve :
- arbitrage formel des **OQ-10 à OQ-16** (PRD §4.15.10) — les RECO documentées sont raisonnables, à confirmer par CTO ;
- application des **5 Conditions Build** (§3) — toutes documentées dans DoD Build PRD §4.15.14 ;
- sign-off CTO final Design Ticket 4.5 (DoD Design PRD §4.15.13 dernière case).

Le Design peut être mergé. Le Build ne peut démarrer qu'après sign-off CTO **et** validation OQ-10..OQ-16.

---

*Pré-revue sécurité Design PRD-004 Ticket 4.5 v1.0 — 2026-05-12 — méthode [BMAD-light](../method/BMAD.md). Rapport Verify final à produire après Build (méthode Verify PRD-003 PR #13 comme référence).*
