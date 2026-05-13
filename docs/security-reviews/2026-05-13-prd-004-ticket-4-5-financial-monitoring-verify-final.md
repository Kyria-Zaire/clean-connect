# Audit Sécurité — PRD-004 Ticket 4.5 Financial Monitoring — **Verify FINAL** (fermeture `FIN-ITER2-DEBTS`)

**Auditeur** : Reviewer Sécurité (`reviewer-securite-code` + `architecte-api` + `securite` + `sre`)
**Cible** : branche `feat/fin-iter2-debts` (PR à ouvrir) — diff vs `main` post-merge PR #23 (READY WITH DEBT)
**Date** : 2026-05-13
**Commits audités** (6) :
  - `64266a7` `feat(finance): FIN-MANUAL-RATELIMIT — pg_advisory_xact_lock`
  - `99be332` `feat(finance): FIN-STALE-RUNS — fail-safe tous FinanceRunType`
  - `2f533bc` `feat(finance): FIN-RECONCILE-PAGING — cursor + boucle bornée`
  - `2d9d41b` `test(payments): FIN-WEBHOOK-TESTS — concurrence duplicate stripe_event_id`
  - `e17d0f9` `feat(finance): FIN-DAILY-EMAIL (#24) — Resend + alerte P1`
  - `550b628` `test(integration): aligner Ticket 4.5 runManual lock avec FIN-MANUAL-RATELIMIT`

**Verdict** : ✅ **READY** (engineering) — fermeture officielle `FIN-ITER2-DEBTS`.
**Conditions activation production** : ⏳ inchangées — **smoke recette FF=true** + **DPO sign-off** + **CTO sign-off** restent obligatoires (cf. PRD §4.15.17).

---

## 1. Synthèse exécutive

| Sévérité | Compte | Bloquant merge ? |
|---|---|---|
| 🔴 Critique | **0** | — |
| 🟠 Important | **0** | — |
| 🟡 Suggestion | 3 | Non |
| 🟢 Conforme | 17 | — |

| Domaine | Statut |
|---|---|
| Fermeture des 5 dettes `FIN-ITER2-DEBTS` (#24-#28) | ✅ |
| `FF_FINANCE_MONITORING_ENABLED=false` par défaut | ✅ |
| Tests intégration locaux verts (404 unit + 18 suites integration) | ✅ |
| Typecheck strict + lint zéro warning | ✅ |
| Aucune correction Stripe destructive | ✅ |
| Cardinalité Prometheus bornée (whitelist freeze) | ✅ |
| Locks anti-overlap actifs sur tous schedulers | ✅ |
| Rétention DB plafonnée (90 j / 1825 j / 30 j) | ✅ |
| Sanitization alerte / log / email | ✅ (avec dette F3 historique trackée) |
| CI GitHub (Quality / Integration / Docker / CodeRabbit) | ⏳ **à ouvrir avec la PR** |
| Smoke recette FF=true | ⏳ humain (checklist §6) |
| DPO sign-off | ⏳ humain (checklist §7) |
| CTO sign-off | ⏳ humain (checklist §8) |

---

## 2. Fermeture effective des 5 dettes

### FIN-MANUAL-RATELIMIT (#26)

- **Code** : `FinanceRepository.tryReserveManualRun` ([`finance.repository.ts:277-311`](../../apps/api/src/modules/finance/finance.repository.ts)) — transaction Prisma + `pg_advisory_xact_lock(hashtext('finance.manual_rate:<userId>'))` user-scoped. `count + INSERT` atomique.
- **Service** : `FinanceReconcileService.runManual` ([`finance-reconcile.service.ts:82-143`](../../apps/api/src/modules/finance/services/finance-reconcile.service.ts)) — `429 FINANCE_MANUAL_RUN_RATE_LIMIT` si quota OQ-13 dépassé, `409 FINANCE_RECONCILE_BUSY` si lock global busy (avec `failRun('lock_busy')` sur le run réservé pour ne **pas** laisser de zombie `RUNNING`).
- **Tests** : `finance-iter2-debts.integration.spec.ts` (atomicité concurrente) + `finance-ticket-4-5.integration.spec.ts` (`lock_busy` → `409` + run `FAILED`).
- **Vérification cardinalité** : aucune nouvelle clé Redis dynamique, aucune table de cache parallèle — l'unique état persistant = `FinanceReconciliationRun` (déjà soumis à rétention 90 j).
- ✅ **Fermée**

### FIN-STALE-RUNS (#27)

- **Code** : `FinanceRepository.markStaleRunningRunsFailed` + `markAllStaleRunningRunsFailed` ([`finance.repository.ts:94-131`](../../apps/api/src/modules/finance/finance.repository.ts)) + constant `FINANCE_RUN_TYPE_MAX_AGE_MS` ([`finance.constants.ts:293-299`](../../apps/api/src/modules/finance/finance.constants.ts)).
- **Schedulers** : appel pre-lock dans `finance-reconcile.scheduler.ts:39`, `finance-stuck-funds.scheduler.ts`, `finance-invariants.scheduler.ts`, `finance-payout-anomaly.scheduler.ts`, `finance-daily-report.scheduler.ts`, `finance-retention.scheduler.ts` (Grep confirme 6/6 schedulers).
- **Couverture** : 5 `FinanceRunType` (RECONCILE / STUCK / INVARIANTS / PAYOUT_ANOMALY / REPORT) — alignée sur `FINANCE_LOCK_TTL_MS`.
- **Sémantique** : `failureMessage = 'stale_run_detected'`, `completedAt = now()`, statut `FAILED` (audit + alerting cohérent).
- ✅ **Fermée**

### FIN-RECONCILE-PAGING (#25)

- **Code** : `FinanceRepository.listRecentPaymentsForReconcile` ([`finance.repository.ts:377-417`](../../apps/api/src/modules/finance/finance.repository.ts)) — cursor keyset `(updatedAt, id)` `OR`-désambiguïsé, `orderBy: [{updatedAt:'desc'},{id:'desc'}]`, `take = min(max(limit,1),1000)`.
- **Service** : `FinanceReconcileService.executeReconcile` ([`finance-reconcile.service.ts:166-223`](../../apps/api/src/modules/finance/services/finance-reconcile.service.ts)) — boucle bornée `pagesProcessed < maxPages`, sortie anticipée si `bundles.length < batchSize`, log `finance.reconcile.run.window_truncated` (warn) si plafond atteint (peek de 1 row).
- **Env** : `FINANCE_RECONCILE_BATCH_SIZE` (1..600 default 600), `FINANCE_RECONCILE_MAX_PAGES` (1..500 default 100).
- **Tests** : `finance-reconcile-paging.integration.spec.ts` — 7 Payments / `batchSize=2` via env bootstrap → plusieurs pages cursor vertes.
- **Garanties** : `p-limit` interne (inchangé), timeout Stripe (inchangé), métriques (inchangées).
- ✅ **Fermée**

### FIN-WEBHOOK-TESTS (#28)

- **Test** : `payments-webhook.integration.spec.ts` — 2 POST concurrents body identique (`stripe_event_id` unique) → **1 ligne DB**, l'un répond `idempotent: false`, l'autre `idempotent: true`.
- **Invariants webhook (existants, ré-audités)** :
  - HMAC `constructEvent` **avant** désérialisation ([`payments-webhook.service.ts:115-141`](../../apps/api/src/modules/payments/webhooks/payments-webhook.service.ts)).
  - `livemode ↔ APP_ENV` enforcé (mismatch → exception dédiée).
  - `payloadHash = sha256(rawBody)` anti-tampering.
  - Throttler skip explicite (`@SkipThrottle()`) — signature HMAC = authent unique.
  - Raw body buffer obligatoire (NestJS `rawBody: true` au boot).
- **Limite documentée** : invariant `MISSING_STRIPE` reconcile dédié (`FIN-I-012`) **non livré** dans cette itération — reste `TODO(debt)` / ADR si besoin métier (cf. §9).
- ✅ **Fermée** (sur l'axe idempotence concurrente ; `MISSING_STRIPE` reconcile = dette future)

### FIN-DAILY-EMAIL (#24)

- **Code** : `FinanceDailyReportService.trySendDailyReportEmail` ([`finance-daily-report.service.ts:168-224`](../../apps/api/src/modules/finance/services/finance-daily-report.service.ts)) — `fetch` HTTPS Resend + `AbortSignal.timeout(15_000)` + headers `Authorization: Bearer ${RESEND_API_KEY}` (jamais loggé).
- **Payload email** (`buildEmailPayload`) : **aucun PII** — uniquement agrégats numériques + flag `balanceHealthy` + counts open mismatches P1/P2. Reviewable via `GET /v1/admin/finance/daily-report/:date`.
- **Fallback alerte** : `finance_daily_report_failed` P1 cooldown 1 h scope `<stage>:<dateISO>` — `stage = 'email' | 'generation'` (2 scopes distincts). Émis via `FinanceAlertingService` (deepSanitize re-appliqué côté `context`).
- **Env** : `RESEND_API_KEY`, `FINANCE_DAILY_REPORT_EMAIL_TO`, `RESEND_FROM_EMAIL` — **tous optionnels** ; absence ⇒ skip silencieux (log debug `email_skipped_no_resend_config`).
- **Tests** : `finance-daily-report-email.integration.spec.ts` — happy path + HTTP 500 fail + génération fail + skip no-config (mock `fetch`).
- ✅ **Fermée**

---

## 3. FF_FINANCE_MONITORING_ENABLED — kill-switch

| Localisation | Vérification |
|---|---|
| [`env.ts:216-219`](../../apps/api/src/common/config/env.ts) | Zod `default('false').transform(v=>v==='true')` — pas de coercion implicite |
| `.env.example` ligne 99 | `FF_FINANCE_MONITORING_ENABLED=false` |
| 6 schedulers finance | Grep confirme `if (!env.FF_FINANCE_MONITORING_ENABLED) return` dans **tous** (`reconcile`, `stuck-funds`, `invariants`, `payout-anomaly`, `daily-report`, `retention`) |
| Endpoint admin `POST /v1/admin/finance/runs/manual` | **N'est pas gated par FF** (intentionnel — l'admin doit pouvoir déclencher un run pour debug même si le cron est off ; RBAC + rate-limit OQ-13 protègent) |

**Recommandation Verify** : la non-protection FF de l'endpoint admin manuel est **acceptable** car (a) RBAC ADMIN + JWT obligatoire, (b) rate-limit 1/h atomique, (c) lock anti-overlap, (d) aucune mutation Stripe — uniquement read-only retrieve. Documenté dans le runbook.

✅ **Conforme**

---

## 4. Invariants critiques finance

| Invariant | Vérifié sur | Statut |
|---|---|---|
| Aucun double payout | `FinanceReconcileService` n'appelle **jamais** `transfers.create` / `transfers.retry` — seulement `retrievePaymentIntent/Transfer/Refund` (read-only) | ✅ |
| Aucun double refund | Idem — aucun `refunds.create` côté reconcile | ✅ |
| Aucun auto-fix Stripe | Aucune mutation Stripe dans `apps/api/src/modules/finance/**` (grep confirmé `create/update/capture/cancel` absent) | ✅ |
| Aucun side-effect duplicate webhook | `stripe_event_id` UNIQUE + transaction Prisma + test concurrence vert | ✅ |
| Mismatch persistence cohérente | Index unique `(runId, mismatchCode, resourceKind, resourceId)` + `P2002 → 'duplicate'` ([`finance.repository.ts:144-163`](../../apps/api/src/modules/finance/finance.repository.ts)) | ✅ |
| Lifecycle mismatch cohérent | Machine d'état `FINANCE_MISMATCH_TRANSITIONS` Frozen (`OPEN→ACK/INV/RES/IGN`, `RESOLVED/IGNORED` terminaux) — invalides → `409` | ✅ |

### Schedulers

| Garantie | Mécanisme | Statut |
|---|---|---|
| Aucun overlap | `FinanceSchedulerLockService.withLock(key, ttlMs, …)` sur 6/6 schedulers | ✅ |
| Locks OK | `FINANCE_LOCK_KEYS` figés (6 clés), TTLs alignés `FINANCE_LOCK_TTL_MS` 10-15 min | ✅ |
| Stale cleanup OK | `markAllStaleRunningRunsFailed` appelé pre-lock | ✅ |
| Cooldown OK | `FinanceAlertingService.cooldownMap` + table figée par kind (15 min - 24 h) | ✅ |

### Métriques

| Garantie | Mécanisme | Statut |
|---|---|---|
| Cardinalité bornée | `FINANCE_METRIC_LABELS` `Object.freeze` + 7 catégories × N littéraux ; PRD-004 §4.15.6 total ~65 séries | ✅ |
| Labels whitelistés | `assertLabel(value, whitelist, context)` runtime sur **chaque** `inc/observe/set` | ✅ |
| Aucune dérive dynamique | TypeScript signatures `*MetricType` ne laissent passer que des littéraux à la compilation ; runtime guard double protection | ✅ |
| Pas de userId/missionId/email/phone en label | Confirmé par lecture `FinanceMetricsTracker.ts` (aucun champ libre) | ✅ |

---

## 5. Alerting / Logs / Emails — absence PII

| Vecteur | Garde | Statut |
|---|---|---|
| Logs Pino | Redactor PII configuré au boot ; `deepSanitize` appliqué à `context` alerte | ✅ |
| Metrics Prometheus | Whitelist labels (cf. §4) | ✅ |
| Alertes `FinanceAlert.context` | `deepSanitize` re-appliqué côté `emit` (audit Verify V4) — clés sensibles → `[REDACTED]` | ✅ |
| Email daily report | Payload `buildEmailPayload` — **uniquement agrégats numériques**, jamais de userId/email/intentId/paymentId. Bearer Resend uniquement en header (jamais loggé) | ✅ |

**Note F3 historique** (rapport `*-build-verify.md` §F3) : `deepSanitize` redact les **clés** sensibles mais ne ré-applique pas `redactSecretsInString` sur les **valeurs string**. Pour `finance_daily_report_failed`, le `context` injecté contient uniquement `stage` + `detail` tronqué à 200 chars (sans Bearer, sans userId, sans token). Aucune régression introduite par #24. **Suggestion** maintenue pour itération future (cf. §9 S2).

---

## 6. Checklist Smoke Recette `FF=true` (à exécuter manuellement avant prod)

Cette checklist est **opérationnelle humaine** — à exécuter par SRE/ops sur l'env `recette` après merge PR.

### 6.1 Activation flag

- [ ] `FF_FINANCE_MONITORING_ENABLED=true` dans secrets `recette` uniquement
- [ ] Redémarrage rolling `apps/api` recette confirmé via `/healthz` et `/readyz`
- [ ] Logs `finance.<scheduler>.disabled` **disparaissent** sur tous les 6 schedulers

### 6.2 Schedulers

- [ ] **Reconcile** : log `finance.reconcile.run.start` apparaît à `03:30 Europe/Paris` (ou après un manual run admin)
- [ ] **Reconcile** : log `finance.reconcile.run.done scanned=N mismatches=M alerts=K` apparaît
- [ ] **Reconcile** : aucun `finance.reconcile.run.failed` ; si présent → consigner runId + relancer
- [ ] **Stuck funds** : tick horaire `HH:05` ; pas d'alerte `finance_stuck_*` (recette ⇒ payments synthétiques)
- [ ] **Invariants** : tick `04:15` ; pas d'invariant break sur le dataset recette
- [ ] **Payout anomaly** : tick `04:45` ; `cleanconnect_finance_payout_anomaly_factor` observed
- [ ] **Daily report** : tick `07:00` ; row `FinanceDailyReport` créé pour J-1 ; `balanceHealthy=true` (tolérance 1 cent)
- [ ] **Retention** : tick `02:30` ; `finance.retention.done deletedMismatches=… deletedReports=… deletedAlerts=… deletedRuns=…`

### 6.3 Endpoints admin

- [ ] `GET /v1/admin/finance/mismatches` → 200 ADMIN, 403 CLIENT, 401 sans JWT
- [ ] `POST /v1/admin/finance/runs/manual` → 202 ACCEPTED 1ère fois, **429** 2ème fois dans l'heure (OQ-13), **409** si concurrent avec cron
- [ ] `PATCH /v1/admin/finance/mismatches/:id` → transitions invalides → 409, RESOLVED sans notes ≥ 16 → 400

### 6.4 Webhooks

- [ ] Replay manuel d'un webhook `payment_intent.succeeded` → 1ère fois `accepted:true,idempotent:false`, 2ème fois `accepted:true,idempotent:true`
- [ ] Signature falsifiée → 400 `INVALID_SIGNATURE`
- [ ] `livemode=true` sur env recette (`sk_test_*`) → 400 `LIVEMODE_MISMATCH`

### 6.5 Email daily report (FIN-DAILY-EMAIL)

- [ ] Secrets `RESEND_API_KEY` + `FINANCE_DAILY_REPORT_EMAIL_TO` + `RESEND_FROM_EMAIL` provisionnés en recette
- [ ] Email reçu à `FINANCE_DAILY_REPORT_EMAIL_TO` (boîte ops) après tick 07:00
- [ ] **Contenu email = agrégats numériques uniquement** (aucun userId, aucun email client, aucun stripeId visible)
- [ ] Simuler `RESEND_API_KEY` invalide → alerte `finance_daily_report_failed` P1 émise (DB + Discord/log)

### 6.6 Métriques Prometheus

- [ ] `/internal/metrics` (auth bearer) expose les séries `cleanconnect_finance_*`
- [ ] Cardinalité observée ≤ 80 séries (marge sur les 65 théoriques)
- [ ] Aucun label `userId=` / `missionId=` / `paymentId=` / `email=` / `stripeId=` (grep sur l'output)

### 6.7 Dashboards Grafana

- [ ] Dashboard `Finance — Reconciliation` charge sans 5xx
- [ ] Panel `Open mismatches by severity (P1/P2)` affiche 0 ou cohérent
- [ ] Panel `Reconciliation duration P95` < 60 s
- [ ] Panel `Daily report invariant balance J-1` à 0 (± 1 cent)

### 6.8 BullBoard / DLQ

- [ ] BullBoard readonly accessible (auth bearer admin)
- [ ] DLQ `stripe-webhooks` consultable, replay manuel fonctionnel (déjà couvert PRD-003)

### 6.9 Alerting Discord (P0/P1/P2)

- [ ] Test alerte P1 forcée (`finance_daily_report_failed` avec stub) → message Discord canal `#alerts-finance`
- [ ] Cooldown respecté — 2ème déclenchement dans la fenêtre → pas de message (log `finance.alert.cooldown`)
- [ ] **Aucun secret Discord/email** dans le payload (vérif visuelle du webhook URL côté serveur)

### 6.10 Absence PII (3 vecteurs)

- [ ] **Logs** : `grep -E '(@|sk_(test|live)_|whsec_|Bearer )'` sur 24 h de logs recette → 0 fuite
- [ ] **Metrics** : `/internal/metrics` ne contient aucun pattern email/stripeId/uuid v4 hors `id_truncated`
- [ ] **Emails** : sample 3 daily reports → 0 PII

---

## 7. Checklist DPO

- [ ] Rétention `FinanceMismatch` 90 j confirmée (RGPD — minimisation)
- [ ] Rétention `FinanceDailyReport` 5 ans (1825 j) — justifiée par Code de commerce art. L123-22 (10 ans pour pièces comptables ; 5 ans pour reports agrégés non-comptables → à arbitrer DPO)
- [ ] Rétention `FinanceAlert` 30 j (audit cooldown post-mortem)
- [ ] Aucun PII dans `FinanceMismatch.dbSnapshot` / `stripeSnapshot` (whitelist `FINANCE_SNAPSHOT_WHITELIST`)
- [ ] Aucun PII dans emails Resend (cf. §6.5)
- [ ] Aucun PII dans labels Prometheus (cf. §4)
- [ ] Aucun PII dans alertes Discord (cf. §6.9)
- [ ] Tableau de rétention Finance ajouté à la doc DPO interne (PRD-004 §4.15.4)
- [ ] Anonymisation `db-sync prod→preprod` confirmée (script `scripts/db-sync.sh`)

---

## 8. Checklist CTO (gate merge final)

- [ ] PR `feat/fin-iter2-debts` ouverte et liée aux issues #24-#28 + PRD §4.15.17
- [ ] CI GitHub complète verte :
  - [ ] Quality (lint + typecheck + unit)
  - [ ] Integration (jest --config jest.integration.config.ts)
  - [ ] Docker Build
  - [ ] CodeRabbit (0 finding bloquant)
- [ ] 6 commits atomiques (1 par dette + alignement test Ticket 4.5) — pas de squash forcé avant revue
- [ ] CHANGELOG mis à jour (bloc Unreleased §FIN-ITER2-DEBTS)
- [ ] PRD §4.15.17 mis à jour avec statut **closed**
- [ ] Rapport Verify final (ce document) lié en commentaire PR
- [ ] Smoke recette (§6) exécuté et signé
- [ ] DPO sign-off (§7) reçu par écrit
- [ ] Plan de rollback documenté :
  - `FF_FINANCE_MONITORING_ENABLED=false` → désactivation immédiate des 6 schedulers
  - Revert PR possible sans migration DB (toutes les modifs sont code/schema **additif**, aucune migration destructive dans cette PR)
- [ ] Décision : merge `feat/fin-iter2-debts` → `main` ✅ / ⏸️

---

## 9. Risques résiduels & dettes ouvertes

### Dettes restantes (NON bloquantes — ouvertes en `TODO(debt)`)

| ID | Localisation | Description | Sévérité résiduelle |
|---|---|---|---|
| **F3 historique** | `finance-alerting.service.ts:127` | `deepSanitize` redact les clés sensibles mais ne ré-applique pas `redactSecretsInString` sur les valeurs string ; risque théorique si un `detail` contenait un secret. Mitigé : `detail` tronqué 200 chars, sources contrôlées (`err.message` interne + body Resend). | Suggestion S2 — itération future |
| **`MISSING_STRIPE` reconcile** | (à créer) | Invariant `FIN-I-012` détectant un Stripe object 404 vs DB existant. Non livré dans #28 — l'axe couvert est l'idempotence webhook concurrent. ADR à ouvrir si besoin métier (faible probabilité opérationnelle). | Suggestion S3 — sur demande métier |
| **Bascule DST Europe/Paris daily balance** | (à créer) | Le 2 fois/an DST switch peut produire une fenêtre J-1 de 23 h ou 25 h. Effet sur `balanceCents` négligeable (tolérance 1 cent). | Suggestion mineure |

### Suggestions Verify

- **S1** : Ajouter une **métrique gauge** `cleanconnect_finance_stale_runs_marked_total{type}` incrémentée à chaque `markAllStaleRunningRunsFailed` non-nul — fournit un signal sur la santé des workers.
- **S2** : Étendre `deepSanitize` pour ré-appliquer `redactSecretsInString` sur les valeurs string (filet de sécurité supplémentaire — pas bloquant).
- **S3** : Implémenter l'invariant `FIN-I-012 MISSING_STRIPE` côté reconcile (nécessite ADR Design dédié).

### Risques opérationnels résiduels

| Risque | Mitigation actuelle | Action recommandée |
|---|---|---|
| Resend rate-limit / panne | Alerte P1 `finance_daily_report_failed` (stage=email) | Documenter un fallback SMTP secondaire (post-MVP) |
| Postgres advisory lock saturé | TTL transaction Prisma courte ; lock relâché à COMMIT/ROLLBACK ; pas de blocage longue durée | Monitoring `pg_stat_activity` côté SRE |
| Cardinalité Prometheus future | Whitelist freeze + tests cardinalité unitaires | PR review obligatoire sur tout ajout de label finance |
| Rollback post-activation prod | FF=false dispo + aucune migration destructive | Doc runbook `docs/runbooks/finance-monitoring.md` (à créer si pas déjà) |

---

## 10. Recommandation finale

### Activation **recette** `FF_FINANCE_MONITORING_ENABLED=true`

✅ **AUTORISÉE** après merge PR `feat/fin-iter2-debts` — **sous condition CI verte uniquement** (pas de gate humain à ce stade).

### Activation **production** `FF_FINANCE_MONITORING_ENABLED=true`

⏳ **CONDITIONNELLE** — exige :

1. Smoke recette §6 entièrement validée par SRE (toutes les checkbox cochées et tracées)
2. DPO sign-off écrit §7
3. CTO sign-off écrit §8
4. Plan de rollback testé en recette (FF=false → FF=true → FF=false sans incident)
5. Runbook `docs/runbooks/finance-monitoring.md` publié et accessible aux astreintes

**STOP CTO requis avant merge final** comme demandé.

---

## Annexe — État CI/local au moment de l'audit

| Gate | Résultat local (apps/api) |
|---|---|
| `pnpm test` (unit) | ✅ 404 passed, 29 suites |
| `pnpm test:integration --runInBand` | ✅ 18 passed, 18 suites |
| `pnpm lint` (eslint --max-warnings=0) | ✅ 0 warning |
| `pnpm typecheck` (tsc --noEmit strict) | ✅ 0 erreur |

CI GitHub : ⏳ à déclencher à l'ouverture de la PR.

---

*Rapport Verify final produit le 2026-05-13 — branche `feat/fin-iter2-debts` @ HEAD `e17d0f9`.*
*Auteur : reviewer-securite-code + architecte-api + securite + sre.*
*À joindre à la PR avant revue CTO.*
