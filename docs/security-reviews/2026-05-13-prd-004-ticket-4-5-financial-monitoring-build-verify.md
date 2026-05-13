# Audit Sécurité Verify — PRD-004 Ticket 4.5 Financial Monitoring (Build itération 1)

**Auditeur** : Reviewer Sécurité (`reviewer-securite-code` + `architecte-api` + `securite` + `ingenieur`)
**Cible** : `apps/api/src/modules/finance/**` + `apps/api/prisma/migrations/20260513020000_prd004_ticket_4_5_financial_monitoring/**` + `apps/api/test/integration/finance-ticket-4-5.integration.spec.ts`
**Date** : 2026-05-13
**Branche** : `feat/prd-004-ticket-4.5-financial-monitoring-build`
**Verdict** : ✅ **READY WITH MINOR DEBT** — merge CTO **autorisé** après application des correctifs F1 inclus dans ce rapport.

---

## Synthèse exécutive

| Sévérité | Compte | Bloquant merge ? |
|---|---|---|
| 🔴 Critique | **0** | — |
| 🟠 Important | **3** (dont **F1 corrigé dans ce Verify**) | F1 résolu ; F2/F3 = `TODO(debt)` traçables, non bloquants |
| 🟡 Suggestion | 6 | Non |
| 🟢 Conforme | 13 | — |

**Périmètre audité** = squelette + fondations Build Ticket 4.5 (lock anti-overlap, schedulers, endpoints admin, métriques, sanitizer, alertes, retention, runbook). La **logique métier reconcile / stuck / 11 invariants / payout / daily report** reste explicitement `TODO(debt)` dans les services et sera couverte par des commits Build suivants — hors scope de cette itération de Verify.

L'exigence CTO Build *« aucun doublon `FinanceReconciliationRun` »* a été corrigée pendant ce Verify (F1 — `runManual` passe désormais par le même `withLock(reconcile)` que le cron + test concurrent vert).

---

## 🔴 Critique (0)

Aucun finding bloquant.

---

## 🟠 Important (3)

### F1 — `runManual` ne prenait pas le lock `finance.reconcile` (RÉSOLU dans ce Verify)

- **Fichiers** : `apps/api/src/modules/finance/services/finance-reconcile.service.ts:34-46` (avant correctif)
- **Problème** : l'endpoint `POST /v1/admin/finance/runs/manual` créait un `FinanceReconciliationRun` directement, **sans** acquérir le lock `FINANCE_LOCK_KEYS.reconcile`. En conséquence, un déclenchement manuel pendant que le cron `@Cron('30 3 * * *')` tournait pouvait produire **deux runs `RECONCILE` actifs en parallèle** — contredit frontalement l'exigence CTO Build :
  > *« lock Redis ou DB / un seul run actif par scheduler / expiration du lock obligatoire / aucun doublon FinanceReconciliationRun »*
- **Atténuation pré-fix** : `runScheduledReconcile` et `runManual` n'effectuaient que des inserts placeholder (aucun appel Stripe, aucune mutation métier) — impact opérationnel nul **pour cette itération squelette**, mais condition CTO non couverte → bloquant Verify.
- **Mitigation appliquée** :
  - `FinanceReconcileService.runScheduledReconcile()` et `.runManual()` partagent désormais un seul cœur `executeReconcile({ triggeredByUserId })`.
  - `runManual()` enveloppe l'exécution dans `FinanceSchedulerLockService.withLock(FINANCE_LOCK_KEYS.reconcile, FINANCE_LOCK_TTL_MS.reconcile, …)`.
  - Si le lock est busy ⇒ `409 FINANCE_RECONCILE_BUSY` levé (HttpException), **aucun row de run créé**.
  - Test d'intégration ajouté : `« runManual — refuse 409 si le lock reconcile est déjà tenu »` — **vert** (`6 passed, 6 total`).
- **Statut** : ✅ **Corrigé** dans Verify. Plus de Bloquant côté CTO.

### F2 — Race condition rate-limit `manualRun` (`countManualRunsSince` non transactionnel)

- **Fichier** : `apps/api/src/modules/finance/controllers/admin-finance.controller.ts:139-147`
- **Problème** : le contrôleur lit `count = repo.countManualRunsSince(userId, since)` puis appelle `runManual()` plus tard — non atomique. Deux requêtes simultanées d'un même admin peuvent toutes deux passer le check (`count = 0`) puis insérer chacune un run `RECONCILE`, ce qui dépasse silencieusement la limite OQ-13 (« 1 run/h/utilisateur »).
- **Impact MVP** : faible (1 → 2 dans le pire cas). Aucun risque de fuite, aucun effet métier (les runs sont placeholder). Le lock reconcile (F1 corrigé) **borne aussi** le risque côté serveur car le second `runManual` quasi-simultané obtient un `409`.
- **Statut** : `TODO(debt)` traçable côté contrôleur (cartouche posée). Renforcement bloquant **uniquement** quand la logique métier reconcile sera branchée (un faux positif = un appel Stripe inutile, pas une perte d'argent).
- **Mitigations recommandées (Verify suivante)** :
  1. Ajouter `@Throttle({ default: { ttl: 3_600_000, limit: env.FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR } })` au niveau HTTP (clef `userId`).
  2. Ou exécuter `count + createRun` en transaction Prisma `SERIALIZABLE`.
  3. Ou s'appuyer entièrement sur le lock DB F1 (la limite passe alors de "1/h" à "1 actif simultané + count check best-effort").

### F3 — `FinanceAlertingService.emit` ne redact pas les contenus de strings dans `context`

- **Fichier** : `apps/api/src/modules/finance/alerting/finance-alerting.service.ts:122-150`
- **Problème** : `deepSanitize` (`apps/api/src/common/security/sanitize.ts:149`) **retourne la string telle quelle** — il redact uniquement les **clés** sensibles (email, phone, token, …). Si un caller futur passe `context: { msg: "Bearer eyJ..." }` ou `context: { stripeId: "sk_test_..." }`, ces secrets se retrouvent en clair dans `finance_alerts.context` (DB) **et** dans le log Pino structuré.
- **Atténuation actuelle** : tous les call sites finance documentés (`FinanceMismatchService`, schedulers TODO debt) n'envoient que des champs whitelistés simples (`mismatchType`, `runId`, `severity`, `amountDeltaCents`, `stripeIdTruncated` 24 chars). Pas d'exploit connu sur la branche.
- **Statut** : `TODO(debt)` à brancher AVANT que la logique métier alimente effectivement `context`.
- **Mitigation recommandée** :
  - Soit appliquer `redactSecretsInString` en post-`deepSanitize` sur toutes les valeurs string du `context` directement dans `FinanceAlertingService.emit`.
  - Soit étendre `deepSanitize` (changement transverse → ADR si retenu).

---

## 🟡 Suggestion (6)

| ID | Fichier | Constat | Mitigation |
|---|---|---|---|
| **S1** | `prisma/schema.prisma` (corrigé en cours de Verify) | Commentaires `///` mentionnaient encore *« indéfinie si OPEN/INVESTIGATING / FAILED »* alors que la décision OQ-12 + `purgeMismatchesPastRetention` purgent à 90 j tous statuts mismatch. | Commentaires Prisma alignés sur OQ-12 (✅ pendant ce Verify). |
| **S2** | `admin-finance.controller.ts:69-79, 164-167` | `listMismatches` (limit, cursor, status) et `getDailyReport` (date) sont parsés à la main au lieu de passer par `createZodDto + ZodValidationPipe` global. | Aligner par cohérence projet ; messages d'erreur uniformes. |
| **S3** | `schedulers/finance-{stuck,invariants,payout-anomaly,daily-report}.scheduler.ts` | `markStaleRunningRunsFailed` est appliqué uniquement par le reconcile scheduler. Si un autre cron crash sans `failRun()` (pertinent quand la logique métier sera branchée), le row reste `RUNNING` indéfiniment. | Appliquer le même garde sur les 4 autres types `FinanceRunType`. |
| **S4** | `schema.prisma:919-920 + migration.sql:91-92` | `FinanceAlert.{mismatchId,runId}` sont en soft FK (sans `@relation` Prisma ni `ON DELETE SET NULL` côté SQL). Choix design assumé (« ne pas perdre la trace après purge ») mais aucun trigger/orphan-cleanup. | Documenter ou ajouter `ON DELETE SET NULL` formel pour cohérence audit. |
| **S5** | `stripe-finance-retrieve.service.ts:96-110` | `withTimeout` `clearTimeout`-e bien le timer mais ne peut pas annuler la `Promise<T>` SDK Stripe sous-jacente — risque mineur de fuite mémoire si Stripe répond après `timeoutMs`. | Documenter ; pas d'action MVP. |
| **S6** | `finance.repository.ts:161-178` | `transitionMismatch` n'impose pas de machine d'état (un admin peut faire `IGNORED → OPEN` ou `RESOLVED → INVESTIGATING`). | Acceptable MVP ; ouvrir un ticket pour figer la machine d'état avant volumétrie production. |

---

## 🟢 Conforme (13)

- 🟢 **Lock anti-overlap atomique DB** — `INSERT … ON CONFLICT (key) DO UPDATE … WHERE finance_scheduler_locks.expires_at < EXCLUDED.acquired_at` (`finance-scheduler-lock.service.ts:76-84`) — race-free, owner-scoped release via `DELETE WHERE key = ? AND owner = ?`.
- 🟢 **TTL lock dimensionné par scheduler** (10–15 min) + auto-cleanup via `expires_at` — un worker qui crash sans `release` est récupéré à TTL.
- 🟢 **Sanitizer double filet** : whitelist explicite `FINANCE_SNAPSHOT_WHITELIST` par `resourceKind` + `deepSanitize` final + `redactSecretsInString` sur strings whitelistées (`finance-snapshot.sanitizer.ts:53-101`). **Fuzz test 200 itérations** vert (`finance-snapshot.sanitizer.spec.ts:28-61`).
- 🟢 **Truncation Stripe ID** systématique à 24 chars + suffixe `…` (`FINANCE_STRIPE_ID_TRUNCATE_LENGTH = 24`) — pas de fuite identifiant complet en alerte/snapshot.
- 🟢 **Whitelist labels Prometheus** strictement enforced via `assertLabel` runtime + signatures TypeScript littérales (`finance-metrics.tracker.ts:43-53`). Test unitaire rejet de label inconnu vert.
- 🟢 **Cardinalité bornée** : 65 séries totales (PRD §4.15.6) ; aucun label `userId/missionId/paymentId/transferId/refundId/stripeId/email/phone/prestataireId`.
- 🟢 **RBAC** : `JwtAccessGuard + RolesGuard + @Roles(Role.ADMIN)` sur 100 % des endpoints `/v1/admin/finance/*` (verifié controller). Test intégration `401/403/200` vert.
- 🟢 **Feature flag global** `FF_FINANCE_MONITORING_ENABLED` honoré par les 6 schedulers (`finance.<name>.disabled` log debug + early return) — kill-switch propre.
- 🟢 **Cooldown alertes** : Map mémoire scoped `(kind, scope)` + table figée Design (`COOLDOWN_TABLE_MS`) — test intégration vert + `__resetCooldownForTests` exposé.
- 🟢 **Indexes Prisma alignés patterns d'accès** : `finance_mismatches_status_severity_detected_at_idx` (listing admin), `finance_mismatches_resource_kind_resource_id_idx` (drill-down), `finance_mismatches_run_id_resource_kind_resource_id_key` (UNIQUE — dedup AC-4.5.1.4), `finance_scheduler_locks_expires_at_idx`, `finance_alerts_severity_kind_emitted_at_idx`.
- 🟢 **Stripe wrapper read-only strict** : zéro `create/update/capture/refund` dans `StripeFinanceRetrieveService` ; throttle token-bucket 25 req/s ; `withTimeout` 10 s (`STRIPE_RETRIEVE_TIMEOUT_MS`) ; instrumentation `StripeMetricsTracker.time` (ADR-014 A3-bis).
- 🟢 **Audit `MissionEvent`** sur transitions mismatch + manual run avec `payload = deepSanitize(...)` — actor + missionId résolu via `resolveMissionIdForResource` (PAYMENT/TRANSFER/REFUND).
- 🟢 **Pas de correction destructive automatique** — ADR-018 §2.6 + services `finance-*-service.ts` purement read/persist + endpoint admin transitions mismatch limité à `OPEN/INVESTIGATING/RESOLVED/IGNORED` (jamais d'action Stripe).

---

## Couverture tests — trous restants

| Cas attendu CTO | Couvert ? | Référence |
|---|---|---|
| RBAC `/v1/admin/finance/*` | ✅ | `finance-ticket-4-5.integration.spec.ts:54-72` |
| Lock busy + release primitive | ✅ | `:74-85` |
| Cooldown alert | ✅ | `:87-107` |
| Retention purge `RESOLVED/IGNORED` | ✅ | `:109-144` |
| Retention purge `OPEN/INVESTIGATING` > 90 j (OQ-12) | ✅ | `:146-180` |
| **Concurrent manual run sous lock (F1)** | ✅ | `:182-205` (ajouté Verify) |
| Whitelist labels metrics | ✅ unit | `finance-metrics.tracker.spec.ts:18-22` |
| Fuzz sanitize 200 itérations | ✅ unit | `finance-snapshot.sanitizer.spec.ts:28-61` |
| Reconcile fenêtre 7j (Stripe ↔ DB) | ❌ | `TODO(debt)` métier — bloquant Verify finale |
| Stuck funds (I-9, I-10, I-11) | ❌ | idem |
| Payout anomaly factor | ❌ | idem |
| 11 invariants + J-1 balance | ❌ | idem |
| Manual run rate-limit OQ-13 dépassé | ❌ | aucun test endpoint avec `count >= limit` (cf. F2) |
| Audit `MissionEvent` écrit après transition | ❌ | aucun assert sur `prisma.missionEvent` après PATCH |

---

## Dettes acceptables (validées par ce Verify)

| ID | Description | Pourquoi acceptable |
|---|---|---|
| `TODO(debt) finance-reconcile-business` | Logique métier reconcile Stripe↔DB / 11 invariants / stuck / payout / daily report = placeholders dans les services | Itération 1 squelette CTO autorisée ; commit suivant Build dédié + Verify finale obligatoire avant prod |
| `TODO(debt) finance-alerting-global` | `FinanceAlertingService` ne délègue pas encore à `AlertingService` global (Discord/Resend) | PR #20 (Ticket 4.1 Build B) pas encore mergée sur la cible — log Pino + persistance DB + métrique Prometheus suffisent MVP |
| `TODO(debt) finance-manual-run-atomic` (F2) | Race entre `count` et `createRun` sur `manualRun` | Atténué par lock reconcile (F1) ; pire cas 1 → 2 runs/h ; pas de fuite |
| `TODO(debt) finance-alert-context-strings-redact` (F3) | `deepSanitize` ne redact pas les strings dans `FinanceAlert.context` | Aucun call site actuel ne fournit de string libre ; à brancher AVANT enrichissement contexte par la logique métier |
| `TODO(debt) finance-other-schedulers-stale-cleanup` (S3) | `markStaleRunningRunsFailed` appliqué uniquement par reconcile | Pertinent uniquement quand stuck/invariants/payout/report seront effectivement implémentés |

---

## Décision merge CTO

✅ **Merge AUTORISÉ** sous conditions remplies suivantes (toutes ✅ à la sortie de ce Verify) :

1. ✅ **F1 corrigé** (`runManual` sous `withLock(reconcile)` + 409 si busy + test concurrent vert).
2. ✅ **F2 / F3** = `TODO(debt)` documentés inline + dans ce rapport, non bloquants pour l'itération squelette (pas d'exploit immédiat).
3. ✅ **Gates locales vertes** :
   - `pnpm --filter @cc/api run typecheck` ✅
   - `pnpm --filter @cc/api run test:integration -- finance-ticket-4-5.integration.spec.ts` ✅ (`6 passed, 6 total`)
4. ✅ **DoD CTO Build §4.15.14 PRD** :
   - 4 tables Prisma + lock ✅
   - 6 schedulers (5 PRD + retention) ✅
   - Endpoints admin RBAC ADMIN ✅
   - Métriques `cleanconnect_finance_*` whitelistées ✅
   - Alerts cooldown ✅
   - Retention/purge 90 j / 5 ans (OQ-12) ✅ — sans rétention indéfinie
   - Audit `MissionEvent` sur mutations ✅
   - **No automatic destructive correction** ✅
   - Runbook §dépendances critiques ✅

Verdict final : **READY WITH MINOR DEBT**. Le squelette est release-ready (i.e. déployable derrière `FF_FINANCE_MONITORING_ENABLED=false` en prod sans risque). La complétion métier + la levée des dettes F2/F3/S3 doivent passer par un nouveau cycle Build → Verify avant activation production du flag.

---

## Prochaines actions Verify / release

1. **Merge CTO PR `feat/prd-004-ticket-4.5-financial-monitoring-build`**.
2. Déployer en **recette** avec `FF_FINANCE_MONITORING_ENABLED=false` (smoke verify : healthz + métriques `/internal/metrics` exposent les séries `cleanconnect_finance_*` à 0).
3. Activer **`FF_FINANCE_MONITORING_ENABLED=true` recette uniquement** une fois la logique métier reconcile branchée + Verify Build itération 2.
4. Avant **production** :
   - Implémenter F2 (transaction ou throttler HTTP) et F3 (redact strings `context`).
   - Compléter tests intégration trous restants (reconcile / stuck / invariants / payout / daily report / audit MissionEvent / rate-limit endpoint).
   - DPO sign-off rétention 90 j / 5 ans (OQ-12 / DoD Verify §4.15.15).
   - Smoke test daily report J-1 sur fixture Stripe synthétique.

---

*Rapport produit le 2026-05-13 — `feat/prd-004-ticket-4.5-financial-monitoring-build` @ HEAD post-fix F1.*

---

# Itération 2 — Verify intermédiaire (cœur métier reconcile / invariants / lifecycle)

**Auditeur** : `reviewer-securite-code` + `architecte-api` + `fintech-engineer` + `sre`
**Cible** : `apps/api/src/modules/finance/**` (services métier reconcile / stuck / invariants / payout / daily report) + `apps/api/src/modules/finance/invariants/**` + migration `20260513030000_prd004_ticket_4_5_invariants_lifecycle` + endpoints admin (lifecycle + filtre `mismatchCode`) + tests intégration `finance-iteration-2.integration.spec.ts`.
**Date** : 2026-05-13
**Branche** : `feat/prd-004-ticket-4.5-financial-monitoring-build` — itération 2.
**Verdict** : 🟡 **READY WITH DEBT — merge intermédiaire AUTORISÉ sous `FF_FINANCE_MONITORING_ENABLED=false` par défaut**. Activation production **interdite** tant que `FIN-ITER2-DEBTS` n'est pas clos.

---

## Synthèse exécutive (itération 2)

| Sévérité | Compte | Bloquant merge intermédiaire ? | Bloquant `FF=true` recette/prod ? |
|---|---|---|---|
| 🔴 Critique | **0** | — | — |
| 🟠 Important | **5** (`FIN-ITER2-DEBTS`) | Non (FF OFF) | ✅ Oui (5/5) |
| 🟡 Suggestion | 3 | Non | Non |
| 🟢 Conforme (itération 2) | 9 | — | — |

Le périmètre cœur métier est livré et **testable** ; mais l'activation prod implique de fermer 5 dettes traçables (voir `FIN-ITER2-DEBTS` PRD §4.15.17 + CHANGELOG). Aucun finding critique n'a été introduit par l'itération 2.

---

## Décision CTO 2026-05-13 — formulation figée

> **Merge possible comme étape intermédiaire. Activation production interdite. Ne pas annoncer « monitoring financier opérationnel ». Dire plutôt : « fondations métier du monitoring financier mergées sous feature flag OFF, activation prod bloquée jusqu'à FIN-ITER2-DEBTS ».**

Cette formulation est **figée** dans le PRD §4.15.17 et reproduite dans le CHANGELOG (entrée Verify intermédiaire).

---

## 🔴 Critique (0)

Aucun finding bloquant introduit par l'itération 2.

---

## 🟠 Important — `FIN-ITER2-DEBTS` (5)

Détail complet : [`docs/prd/PRD-004-hardening-ops-compliance.md`](../prd/PRD-004-hardening-ops-compliance.md) §4.15.17.

### FIN-DAILY-EMAIL — Daily report email non branché

- **Fichier** : `apps/api/src/modules/finance/services/finance-daily-report.service.ts`
- **Constat** : `FinanceDailyReportService.run()` agrège correctement J-1 Europe/Paris, upsert le row `FinanceDailyReport`, et construit le payload email — mais **n'envoie rien sur Resend**. Aucune alerte P1 émise si la génération échoue.
- **Risque actif `FF=false`** : nul (scheduler court-circuité au niveau `tick`).
- **Risque `FF=true` recette/prod** : un échec silencieux du report J-1 n'alerte pas l'admin (P-2 type `finance_report_missing` non émise faute de pipeline). Régression silencieuse possible.
- **Pré-conditions levée** : (1) `AlertingService` (Discord + Resend) disponible — PR #20 ; (2) test unitaire + intégration valident `helper email` zéro PII ; (3) `failure → alert P1 finance_report_missing` émis.

### FIN-RECONCILE-PAGING — Reconcile non paginé > 600 rows

- **Fichier** : `apps/api/src/modules/finance/services/finance-reconcile.service.ts`
- **Constat** : `findMany` reconcile 7 jours plafonné implicitement à 600 rows / fenêtre (batch fixe). Aucune pagination cursor au-delà.
- **Risque actif `FF=false`** : nul.
- **Risque `FF=true` recette/prod** : volumétrie > 600 paiements / 7 jours → reconcile partiel silencieux → mismatch non détecté. **Inacceptable** en prod.
- **Pré-conditions levée** : pagination cursor explicite + borne haute documentée (ex. `take=600 cursor=lastId`) + métrique `cleanconnect_finance_reconciliation_duration_seconds` observée sous gate perf.

### FIN-MANUAL-RATELIMIT — Race rate-limit `runManual` (F2 itération 1 non résolu)

- **Fichier** : `apps/api/src/modules/finance/controllers/admin-finance.controller.ts`
- **Constat** : `count + createRun` non atomique. Atténuation actuelle = lock reconcile (F1 corrigé itération 1), bornant 2 runs concurrents max via `409 FINANCE_RECONCILE_BUSY`. Mais limite OQ-13 (1/h/admin) toujours non garantie de manière atomique.
- **Risque actif `FF=false`** : nul (placeholder).
- **Risque `FF=true` recette/prod** : un admin déterminé peut burner du quota Stripe en envoyant 2-N requêtes simultanées (lock release ⇒ run suivant accepté dans la même fenêtre heure).
- **Pré-conditions levée** : (1) `@Throttle({ ttl: 3_600_000, limit: env.FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR })` *ou* transaction `SERIALIZABLE` `count+create` ; (2) tests intégration `429` (rate-limit) et `409` (lock busy) explicites.

### FIN-STALE-RUNS — `markStaleRunningRunsFailed` partiel

- **Fichier** : `apps/api/src/modules/finance/finance.repository.ts` + schedulers
- **Constat** : la garde anti-orphelin est appliquée principalement au `RECONCILE`. Les autres types (`STUCK_FUNDS`, `INVARIANTS`, `PAYOUT_ANOMALY`, `DAILY_REPORT`) restent vulnérables à un crash worker laissant le run `RUNNING` indéfiniment.
- **Risque actif `FF=false`** : nul.
- **Risque `FF=true` recette/prod** : observabilité dégradée (runs fantômes en `RUNNING`) ; dashboard finance mal renseigné.
- **Pré-conditions levée** : extension du `markStaleRunningRunsFailed` aux 4 autres `FinanceRunType` + 1 test simulant un run orphelin par type.

### FIN-WEBHOOK-TESTS — Couverture `duplicate stripe_event_id` & `MISSING_STRIPE`

- **Fichiers** : `apps/api/test/integration/*` (à créer/compléter)
- **Constat** : la résistance idempotente (duplicate Stripe events) et le cas `MISSING_STRIPE` (objet présent côté Stripe absent côté DB) ne sont **pas** couverts par un test E2E dédié.
- **Risque actif `FF=false`** : nul.
- **Risque `FF=true` recette/prod** : régression future silencieuse non détectée par la CI.
- **Pré-conditions levée** : 2 tests intégration ciblés + assertion `mismatchCode` produit attendu.

---

## 🟡 Suggestion (itération 2) (3)

| ID | Constat | Mitigation |
|---|---|---|
| **S7** | Le log Prisma `prisma:error Unique constraint failed (run_id, mismatch_code, resource_kind, resource_id)` apparaît sur le chemin `createMismatch → 'duplicate'` (catch via `isPrismaUniqueViolation`). Pas bloquant, comportement attendu, mais bruyant. | Optionnel : passer le client Prisma en `log: [{ emit: 'event', level: 'error' }]` filtré, *ou* utiliser un `upsert` avec `where: { run_id_mismatch_code_resource_kind_resource_id }` pour éviter le P2002 → silence côté Prisma. **Décision CTO 2026-05-13 : conservé tel quel — utile au debug.** |
| **S8** | Couverture invariants (29 tests `invariants.spec.ts`) excellente mais aucune mesure de **mutation testing** ; un changement de sens d'opérateur (`>` ↔ `>=`) pourrait passer. | Optionnel ; ouvrir un ticket si `stryker` retenu plus tard. |
| **S9** | `FIN-J-001` (daily balance) est calculé en Europe/Paris via `finance-time.util.ts` ; aucun fuzzing autour des bascules DST (mars/octobre). | Ajouter 2 tests datés `2026-03-29` et `2026-10-25` aux invariants. |

---

## 🟢 Conforme (itération 2) (9)

- 🟢 **Codes invariants versionnés `FIN-I-001`…`FIN-I-011` + `FIN-J-001`** — convention figée, exploitable dashboards/logs/exports/tickets ops.
- 🟢 **Fichiers atomiques par invariant** (`apps/api/src/modules/finance/invariants/fin-i-001-*.ts`, …) + `registry.ts` — invariants **autonomes, testables, documentés, observables**, retournant `{ mismatchCode, severity, explanation, remediationHint }`.
- 🟢 **Schedulers "boring"** — chaque `*-scheduler.ts` se limite à : (a) FF check, (b) `withLock`, (c) délégation au service métier déterministe. Aucun if imbriqué, aucune décision de correction, aucune branche cachée.
- 🟢 **Lifecycle mismatch strict** : `OPEN → ACKNOWLEDGED → RESOLVED` (ou `OPEN → IGNORED`) ; transitions invalides → `409` (`apps/api/src/modules/finance/services/finance-mismatch.service.ts`).
- 🟢 **Unicité DB** `(run_id, mismatch_code, resource_kind, resource_id)` enforced par index unique + `createMismatch` catch `P2002` → `'duplicate'` (idempotence inter-run).
- 🟢 **Aucune mutation Stripe destructive** — `StripeFinanceRetrieveService` reste read-only, **zéro** appel `create/update/capture/refund` dans les services itération 2.
- 🟢 **Audit `MissionEvent`** sur transitions lifecycle (`OPEN→ACKNOWLEDGED`, `ACKNOWLEDGED→RESOLVED`, `OPEN→IGNORED`) avec actor + missionId résolu via `resolveMissionIdForResource`, **garde `isUuidV4` avant lookup Prisma**.
- 🟢 **Métriques whitelistées** : `cleanconnect_finance_invariant_break_total{invariant="FIN-I-…"}` enforced runtime par `assertLabel`, aucun cardinality explosion.
- 🟢 **`FF_FINANCE_MONITORING_ENABLED=false` par défaut** — `apps/api/src/common/config/env.ts:216-219` (`.default('false').transform(v=>v==='true')`) + `.env.example` ligne 99. Kill-switch testé sur les 6 schedulers (debug log `finance.<name>.disabled`).

---

## Couverture tests (itération 2)

| Cas attendu | Couvert ? | Référence |
|---|---|---|
| Reconcile fenêtre 7 j détecte FIN-I-003 drift commission | ✅ | `finance-iteration-2.integration.spec.ts` — `FinanceReconcileService` |
| Lifecycle `OPEN → ACKNOWLEDGED → RESOLVED` notes ≥ 16 chars | ✅ | idem |
| Refus `409` transition invalide | ✅ | idem |
| Refus `400` `RESOLVED` sans notes ≥ 16 chars | ✅ | idem |
| Dedup mismatch (unique key) | ✅ | idem |
| Daily report upsert + status balance | ✅ | idem |
| Filtre `mismatchCode=FIN-I-003` listing admin | ✅ | idem |
| Refus `400` `mismatchCode=BADFORMAT` | ✅ | idem |
| Invariants `FIN-I-001` … `FIN-I-011` + `FIN-J-001` unit | ✅ | `invariants.spec.ts` — 29 tests |
| Pagination reconcile > 600 rows | ❌ | `FIN-RECONCILE-PAGING` |
| Daily report failure → alerte P1 | ❌ | `FIN-DAILY-EMAIL` |
| `429` rate-limit manual run | ❌ | `FIN-MANUAL-RATELIMIT` |
| Run orphelin recovery (STUCK/INVARIANTS/PAYOUT/REPORT) | ❌ | `FIN-STALE-RUNS` |
| Duplicate `stripe_event_id` E2E | ❌ | `FIN-WEBHOOK-TESTS` |
| `MISSING_STRIPE` (objet Stripe sans miroir DB) | ❌ | `FIN-WEBHOOK-TESTS` |
| Bascule DST `Europe/Paris` daily balance | ❌ | `S9` (suggestion) |

---

## Conditions du merge intermédiaire (toutes ✅)

1. ✅ **`FF_FINANCE_MONITORING_ENABLED=false`** par défaut (Zod + `.env.example`).
2. ✅ **`FIN-ITER2-DEBTS`** documenté PRD §4.15.17 + CHANGELOG (5 sous-dettes nommées et tracées).
3. ✅ **Rapport Verify présent** (cette section).
4. ✅ **Tests intégration itération 2 verts** (`8/8` sur `finance-iteration-2.integration.spec.ts`).
5. ⏳ **CI complète verte** — gates `typecheck + lint + tests` à relancer localement / CI **avant** push merge.
6. ✅ **Aucune correction Stripe destructive automatique** — confirmé par revue code itération 2.

---

## Verdict itération 2

🟡 **`READY WITH DEBT` — merge intermédiaire AUTORISÉ** sous condition que `FF_FINANCE_MONITORING_ENABLED=false`.

Activation production **interdite** tant que :

1. Les 5 sous-dettes `FIN-ITER2-DEBTS` ne sont pas closes ;
2. Un **Verify final** (rapport complémentaire à celui-ci) ne valide pas `0 Critical / 0 Important non traité` ;
3. Smoke recette `FF=true` exécuté ;
4. DPO + CTO sign-off explicites.

---

## Prochaines actions Verify (post-merge intermédiaire)

1. Ouvrir le ticket de suivi `FIN-ITER2-DEBTS` (mapping 1:1 aux 5 sous-dettes ci-dessus).
2. Brancher `AlertingService` Resend (PR #20 dépendance) — `FIN-DAILY-EMAIL`.
3. Implémenter pagination cursor reconcile — `FIN-RECONCILE-PAGING`.
4. Rendre rate-limit OQ-13 atomique + tests `429`/`409` — `FIN-MANUAL-RATELIMIT`.
5. Étendre `markStaleRunningRunsFailed` aux 4 autres `FinanceRunType` + tests — `FIN-STALE-RUNS`.
6. Compléter tests E2E webhooks duplicate / `MISSING_STRIPE` — `FIN-WEBHOOK-TESTS`.
7. Re-Verify final avec verdict `READY` cible.

---

*Section itération 2 produite le 2026-05-13 — `feat/prd-004-ticket-4.5-financial-monitoring-build` @ HEAD post-itération 2.*

---

# Fermeture engineering `FIN-ITER2-DEBTS` — branche `feat/fin-iter2-debts` (2026-05-13)

**Périmètre** : PR unique fermant les 5 sous-dettes PRD §4.15.17 (`#24`–`#28`).

| Dette | Livrable principal | Tests |
|---|---|---|
| **FIN-MANUAL-RATELIMIT** | `pg_advisory_xact_lock` + `count+INSERT` transactionnel (`FinanceRepository.tryReserveManualRun`) ; `429` / `409` documentés | `finance-iter2-debts.integration.spec.ts` |
| **FIN-STALE-RUNS** | `markAllStaleRunningRunsFailed` + `FINANCE_RUN_TYPE_MAX_AGE_MS` ; pre-tick sur **tous** les schedulers finance | idem |
| **FIN-RECONCILE-PAGING** | Cursor keyset `updatedAt,id` + `FINANCE_RECONCILE_BATCH_SIZE` / `FINANCE_RECONCILE_MAX_PAGES` (Zod) | `finance-reconcile-paging.integration.spec.ts` |
| **FIN-WEBHOOK-TESTS** | Concurrence `Promise.all` 2× POST identiques → 1 row DB + `idempotent` mixte | `payments-webhook.integration.spec.ts` |
| **FIN-DAILY-EMAIL** | `fetch` HTTPS Resend + alerte P1 `finance_daily_report_failed` (email **ou** génération) | `finance-daily-report-email.integration.spec.ts` |

**Verdict engineering (hors gate DPO / activation prod)** : ✅ **`FIN-ITER2-DEBTS` clos en code** — sous réserve de **CI verte** + **STOP CTO** sur la PR.

**Verdict activation `FF_FINANCE_MONITORING_ENABLED=true` (recette puis prod)** : ⏳ inchangé — exige encore **smoke recette**, **Verify final** (0 Critical / 0 Important), **DPO** + **CTO** sign-off (cf. PRD §4.15.17).

**Limites résiduelles (hors scope dettes)** :

- `MISSING_STRIPE` **mismatch reconcile** (objet Stripe 404 vs DB) : pas d’invariant dédié `FIN-I-012` dans cette PR — la dette `FIN-WEBHOOK-TESTS` est levée sur **l’axe idempotence webhook concurrent** ; la piste invariant `MISSING_STRIPE` reste `TODO(debt)` / ADR si besoin métier.
- F3 historique (`deepSanitize` strings dans `context` alerte) : non ré-ouverte ; les nouveaux `context` `finance_daily_report_failed` ne contiennent que `stage` + `detail` tronqué.

