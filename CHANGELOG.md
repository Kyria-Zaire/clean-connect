# Changelog

Toutes les modifications notables apportées à Clean Connect sont consignées dans ce fichier.

Le format est inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

Chaque entrée référence le PRD pilote (cf. [`docs/prd/README.md`](docs/prd/README.md))
et le rapport sécurité associé (`docs/security-reviews/`).

---

## [Unreleased]

### Ops package recette — PRD-004 §4.15.17 — 2026-05-13 (post-merge PR #29)

PR #29 mergée en squash sur `main` (commit `c3cbb06`). Issues #24-#28 fermées automatiquement. **Aucune migration Prisma** dans le merge → rollback `FF=false` trivial.

Artefacts ops complémentaires (branche `chore/finance-recette-ops-package`) :

- 📋 [`docs/security-reviews/operational-smoke-rec-2026-05-13.md`](docs/security-reviews/operational-smoke-rec-2026-05-13.md) — rapport smoke recette pré-rempli (à compléter par SRE en exécution réelle)
- 👁️ [`docs/runbooks/finance-monitoring-72h-surveillance.md`](docs/runbooks/finance-monitoring-72h-surveillance.md) — checklist surveillance 72 h (cardinalité, alert fatigue, drift, memory, locks)
- 🚦 [`docs/runbooks/finance-monitoring-go-no-go-prod.md`](docs/runbooks/finance-monitoring-go-no-go-prod.md) — grille décision Go/No-Go production (10 critères Go + 8 critères No-Go + sign-offs)

### Verify (fermeture engineering `FIN-ITER2-DEBTS`) — PRD-004 §4.15.17 — 2026-05-13

✅ **Les 5 sous-dettes `FIN-ITER2-DEBTS` sont closes en code** sur la branche `feat/fin-iter2-debts` (PR unique) :

| Code | Résumé |
|---|---|
| `FIN-MANUAL-RATELIMIT` | Rate-limit OQ-13 atomique (`pg_advisory_xact_lock` + transaction `count+INSERT`) |
| `FIN-STALE-RUNS` | `markAllStaleRunningRunsFailed` tous `FinanceRunType` + pre-tick schedulers |
| `FIN-RECONCILE-PAGING` | Cursor `updatedAt,id` + `FINANCE_RECONCILE_BATCH_SIZE` / `MAX_PAGES` (Zod) |
| `FIN-WEBHOOK-TESTS` | Test concurrence duplicate `stripe_event_id` (webhook) |
| `FIN-DAILY-EMAIL` | Envoi Resend (`fetch` HTTPS) + alerte P1 `finance_daily_report_failed` |

**Rappel** : l'activation **`FF_FINANCE_MONITORING_ENABLED=true`** en recette puis prod reste soumise à **smoke recette**, **Verify final** (0 Critical / 0 Important), **DPO** + **CTO** — cf. PRD §4.15.17.

Rapport complémentaire : [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md`](docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md) — section « Fermeture engineering `FIN-ITER2-DEBTS` ».

**Verify final** : [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`](docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md) — verdict **engineering READY** (0 Critical / 0 Important), checklists smoke recette + DPO + CTO incluses.

**Package opérationnel activation FF=true** (PR #29) :

- 🛠️ [`docs/runbooks/finance-monitoring-activation.md`](docs/runbooks/finance-monitoring-activation.md) — runbook activation recette/prod + rollback immédiat (FF=false en < 2 min)
- 📋 [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md`](docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md) — template rapport smoke (à dupliquer par exécution)
- 🛡️ [`docs/dpo/finance-monitoring-rgpd-summary.md`](docs/dpo/finance-monitoring-rgpd-summary.md) — package DPO (inventaire données + rétention + sous-traitants + sign-off)

### Verify (sign-off CTO intermédiaire) — PRD-004 Ticket 4.5 Monitoring financier — 2026-05-13

🟡 **Statut : `READY WITH DEBT` — merge autorisé sous `FF_FINANCE_MONITORING_ENABLED=false` par défaut. Activation production interdite tant que `FIN-ITER2-DEBTS` n'est pas clos.**

Rapport : [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md`](docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md) — section « Itération 2 ».
Ticket dette : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.15.17 `FIN-ITER2-DEBTS`.

#### Décisions

- `FF_FINANCE_MONITORING_ENABLED` reste **`false` par défaut** (Zod `default('false')` + `.env.example`) — kill-switch côté boot vérifié.
- 5 dettes documentées explicitement comme **bloquantes** pour passage `FF=true` en recette/prod :
  - `FIN-DAILY-EMAIL` — branchement Resend + alerte P1 sur échec génération
  - `FIN-RECONCILE-PAGING` — pagination/cursor reconcile > 600 rows / fenêtre
  - `FIN-MANUAL-RATELIMIT` — atomicité OQ-13 (1/h/admin) + tests `429`/`409`
  - `FIN-STALE-RUNS` — `markStaleRunningRunsFailed` étendu à STUCK/INVARIANTS/PAYOUT_ANOMALY/DAILY_REPORT
  - `FIN-WEBHOOK-TESTS` — couverture E2E duplicate `stripe_event_id` + `MISSING_STRIPE`
- Communication interne autorisée : « fondations métier du monitoring financier mergées sous feature flag OFF, activation prod bloquée jusqu'à FIN-ITER2-DEBTS ».
- Communication « monitoring financier opérationnel » **interdite** jusqu'à clôture du ticket de dette.

#### Gates passées

- ✅ Default Zod `FF_FINANCE_MONITORING_ENABLED=false`
- ✅ `apps/api/test/integration/finance-iteration-2.integration.spec.ts` → 8/8 verts
- ✅ Bruit Prisma `P2002` sur dedup mismatch attendu (catch `isPrismaUniqueViolation` → `'duplicate'`) — non bloquant, conservé pour debug

### Build — PRD-004 Ticket 4.5 Monitoring financier (itération 2 — cœur métier) — 2026-05-13

PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.15.16.  
ADR : [`docs/adr/ADR-018-financial-monitoring-reconciliation.md`](docs/adr/ADR-018-financial-monitoring-reconciliation.md).

#### Livré (Build itération 2)

- **Migration Prisma** `20260513030000_prd004_ticket_4_5_invariants_lifecycle` : `ACKNOWLEDGED`, `mismatch_code`, `acknowledged_at`, `acknowledged_by_user_id`, unique `(run_id, mismatch_code, resource_kind, resource_id)`.
- **Invariants** : `FIN-I-001`…`FIN-I-011` + `FIN-J-001` (fichiers `apps/api/src/modules/finance/invariants/`), registry, whitelist métriques `FIN-*`.
- **Services** : reconcile 7j + stuck + invariants J-1 + payout anomaly + daily report (agrégats J-1 Europe/Paris, upsert DB, helper email sans envoi).
- **Admin** : lifecycle mismatch strict + `GET …/mismatches?mismatchCode=`, garde UUID pour audit `MissionEvent`.
- **Tests** : `invariants.spec.ts` (29), `finance-iteration-2.integration.spec.ts` (8), correctif `AllExceptionsFilter(app.get(PinoLogger))` sur suites finance intégration.
- **Verify readiness** : [`docs/ops/finance-iteration-2-verify-readiness.md`](docs/ops/finance-iteration-2-verify-readiness.md).

#### Dette / suite

- Resend daily report ; `MISSING_STRIPE` ; `markStaleRunningRunsFailed` sur STUCK/INVARIANTS/REPORT/PAYOUT_ANOMALY ; pagination reconcile > 600 rows ; rate-limit manual run atomique (F2).

### Design — PRD-004 Ticket 4.5 Monitoring financier — 2026-05-13

🟢 **Phase Design (doc-only) du système de monitoring financier Clean Connect : reconciliation Stripe ↔ DB, stuck funds detector, payout anomalies, daily finance report, invariants comptables.**
PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §2.5 + §4.15.
ADR : [`docs/adr/ADR-018-financial-monitoring-reconciliation.md`](docs/adr/ADR-018-financial-monitoring-reconciliation.md).
Pré-revue sécurité : [`docs/security-reviews/2026-05-12-prd-004-financial-monitoring-design-prereview.md`](docs/security-reviews/2026-05-12-prd-004-financial-monitoring-design-prereview.md).
Runbook ops : [`docs/ops/finance-reconciliation-runbook.md`](docs/ops/finance-reconciliation-runbook.md).

#### Périmètre Design (scope strict CTO)

- **Aucun code runtime**, **aucune migration Prisma**, **aucun endpoint implémenté** — doc-only.
- 5 livrables documentaires :
  - **ADR-018** — stratégie monitoring + 7 principes (Stripe = vérité externe, DB = vérité opérationnelle, reconciliation read-only, cardinalité bornée, audit obligatoire, pas de correction destructive MVP, quotas Stripe respectés).
  - **PRD §4.15** — vision + 9 risques financiers (F-1..F-9) + 6 US raffinées + 4 tables conceptuelles (`FinanceReconciliationRun`, `FinanceMismatch`, `FinanceDailyReport`, `FinanceAlert`) + 11 invariants comptables + 12 métriques + 9 alerts + 7 OQ-10..OQ-16 + modules Nest préfigurés + risk assessment Design + DoD Design/Build/Verify.
  - **Pré-revue sécurité** — 0 Critical / 0 Important / 6 Suggestions / 17 Conformes + 5 Conditions Build obligatoires.
  - **Runbook ops** — 13 sections (lecture mismatch, vérif Stripe/DB, procédures par type de mismatch, stuck funds 3 sous-cas, payout anomaly, procédures admin, escalade, hygiène).
  - **CHANGELOG** — cette entrée.

#### Décisions techniques figées

- **Pas de correction automatique destructive au MVP** (réévaluation T+90 j prod via ADR-019 si patterns reproductibles).
- **DB + logs/metrics** (OQ-11 réponse RECO) : 4 tables Prisma dédiées (`Finance*`) pour traçabilité d'investigation > 30 j.
- **5 crons distincts** : reconcile (03:30), stuck funds (horaire), invariants (04:15), payout anomaly (04:45), daily report (07:00) Europe/Paris.
- **Quota Stripe préservé** : `p-limit(25 req/s)` + `AbortSignal.timeout(5s)`, < 1 % du quota Stripe MVP.
- **AlertingService réutilisé** (ADR-017) avec 9 nouveaux `AlertKind` : `finance_mismatch`, `finance_stuck_funds`, `finance_stuck_authorization`, `finance_transfer_pending`, `finance_refund_mismatch`, `finance_invariant_break`, `finance_reconcile_failed`, `finance_report_missing`, `finance_payout_anomaly`.
- **Cardinalité bornée** : 65 séries Prometheus pour 12 métriques `cleanconnect_finance_*` ; aucun label `userId/missionId/paymentId/transferId/refundId/stripeId/email/phone/prestataireId`.

#### Métriques préfigurées (figées Design)

| Métrique | Type | Labels |
|---|---|---|
| `cleanconnect_finance_reconciliation_runs_total` | counter | `type`, `status` |
| `cleanconnect_finance_reconciliation_duration_seconds` | histogram | `type` |
| `cleanconnect_finance_mismatches_total` | counter | `type`, `severity` |
| `cleanconnect_finance_mismatches_open_count` | gauge | `severity` |
| `cleanconnect_finance_stuck_funds_total` | counter | `kind` |
| `cleanconnect_finance_stuck_funds_amount_cents` | gauge | `kind` |
| `cleanconnect_finance_transfer_pending_total` | counter | — |
| `cleanconnect_finance_refund_mismatch_total` | counter | `kind` |
| `cleanconnect_finance_invariant_break_total` | counter | `invariant` |
| `cleanconnect_finance_invariant_balance_cents` | gauge | `report_date_offset` |
| `cleanconnect_finance_daily_report_generated_total` | counter | `status` |
| `cleanconnect_finance_payout_anomaly_factor` | histogram | — |

#### Alerts préfigurées (figées Design)

| Alerte | Sévérité | Trigger | Cooldown |
|---|---|---|---|
| `finance_mismatch` | P1 | tout `FinanceMismatch.OPEN` | 15 min/`mismatchType` |
| `finance_stuck_authorization` | P1 | `Payment.AUTHORIZED > 5 j` | 4 h/ressource |
| `finance_stuck_captured_funds` | P1 | `Payment.CAPTURED > 24 h sans Transfer terminal` | 1 h/ressource |
| `finance_transfer_pending` | P2 | `Transfer.PENDING > 2 h` | 30 min (batch) |
| `finance_refund_mismatch` | P1 | I-8 rompu | 15 min/`kind` |
| `finance_invariant_break` | P1 | J-1 ou I-3 rompu | 1 h/jour |
| `finance_reconcile_failed` | P1 | cron run = FAILED | 30 min |
| `finance_report_missing` | P2 | report J-1 non-généré 08:00 | 1 day |
| `finance_payout_anomaly` | P2 | factor > 2× moyenne 30 j prestataire | 24 h/prestataire |

#### Décisions CTO (OQ-10..OQ-16) — tranchées 2026-05-12 (Design approuvé, Build autorisé)

- OQ-10 : daily report = **email + dashboard**
- OQ-11 : mismatches **stockés en DB** (4 tables dédiées + lock scheduler)
- OQ-12 : rétention **90 j** après résolution pour `FinanceMismatch` ; **5 ans** pour `FinanceDailyReport` ; **pas de rétention indéfinie**
- OQ-13 : manual run **ADMIN**, rate-limit **1/h/utilisateur**
- OQ-14 : export CSV daily report **reporté Ticket 4.3**
- OQ-15 : `finance_stuck_captured_funds` **> 24 h = P1** (ferme)
- OQ-16 : **aucune correction automatique destructive** au MVP

#### TODO(debt) explicites (à arbitrer Build / Ticket 4.3)

- `debt-prd004-finance-admin-ui` — UI `/admin/finance/*` Ticket 4.3 (mismatches CRUD, daily report viewer, payout anomalies list).
- `debt-prd004-finance-import-from-stripe` — endpoints `POST /v1/admin/transfers/import-from-stripe` + `POST /v1/admin/refunds/import-from-stripe` (cas MISSING_DB Stripe Dashboard).
- `debt-prd004-finance-csv-export` — export CSV daily report — si OQ-14 = oui.

#### Risques résiduels Design

7 risques `RD-4.5-1..7` documentés PRD §4.15.12 — tous `Low` / `Medium`, mitigations Build identifiées. Aucun risque ne bloque le passage en Build.

#### Gates Design

- ✅ Aucun code runtime ajouté (PR doc-only)
- ✅ Aucune migration Prisma lancée
- ✅ Cohérence ADR-018 ↔ PRD §4.15 ↔ runbook vérifiée
- ✅ **Sign-off CTO Design Ticket 4.5** + arbitrage OQ-10..OQ-16 (2026-05-12)

---

### Build — PRD-004 Ticket 4.5 Financial monitoring (squelette + fondations) — 2026-05-13

🟡 **Fondations runtime Ticket 4.5** : schéma Prisma `finance_*` + lock anti-overlap DB, module Nest `finance`, métriques `cleanconnect_finance_*`, endpoints admin `/v1/admin/finance/*`, crons (placeholders métier), tests (sanitizer fuzz, whitelist métriques, RBAC, cooldown alertes, purge rétention), runbook §dépendances critiques.

PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.15. Branche : `feat/prd-004-ticket-4.5-financial-monitoring-build`.

#### Périmètre livré (Build — itération 1)

- Migration `20260513020000_prd004_ticket_4_5_financial_monitoring` : `FinanceReconciliationRun`, `FinanceMismatch`, `FinanceDailyReport`, `FinanceAlert`, `FinanceSchedulerLock` + enums associés.
- **Lock scheduler** : une exécution active par clé cron, TTL + pas de `FinanceReconciliationRun` dupliqué sous overlap (acquisition atomique DB).
- **CI / tests** : fuzz `sanitizeForFinanceSnapshot` ; whitelist labels `FinanceMetricsTracker` ; intégration RBAC `/v1/admin/finance/*` ; cooldown `FinanceAlertingService` ; purge rétention (fenêtres CTO).
- **Runbook** : section *Dépendances critiques* (Stripe, Redis, DB, Prometheus/Grafana, Resend/email).

#### Dette explicite (commits Build suivants — revue CTO)

- Implémentation complète reconcile / stuck funds / 11 invariants / payout anomaly / daily report (hors placeholders `TODO(debt)` dans les services cron).
- Branchement `FinanceAlertingService` → `AlertingService` (canaux) quand fusionné sur la cible.
- OpenAPI `/v1/admin/finance/*` si exigence release.

#### Gates Build (itération 1)

- ✅ `pnpm --filter @cc/api run typecheck`
- ✅ `pnpm --filter @cc/api run lint`
- ✅ `pnpm --filter @cc/api run test`
- ✅ `pnpm --filter @cc/api run test:integration`
- ✅ **Verify CTO Ticket 4.5 itération 1** — rapport [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md`](docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md) — **0 Critical / 3 Important (F1 corrigé en Verify, F2/F3 = `TODO(debt)` non bloquants)** / 6 Suggestions / 13 Conformes — verdict **READY WITH MINOR DEBT**
- 🔧 **Correctif Verify F1** — `FinanceReconcileService.runManual()` passe désormais par `FinanceSchedulerLockService.withLock(reconcile)` ; `409 FINANCE_RECONCILE_BUSY` si lock tenu ; test intégration `« runManual — refuse 409 si le lock reconcile est déjà tenu »` vert. Garantit l'exigence CTO Build « aucun doublon `FinanceReconciliationRun` ».
- ⏸️ **STOP** après merge PR — déploiement recette derrière `FF_FINANCE_MONITORING_ENABLED=false` ; activation prod conditionnée à la complétion métier + nouveau cycle Verify

---

### Build — PRD-004 Ticket 4.1 A3-bis Metrics wiring (Sprint 4) — 2026-05-12

🟢 **Instrumentation runtime des métriques Prometheus posées en A3.**
PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.1 (Build A3-bis). PR #18 (A1+A2+A3) validée CTO et mergée.

#### Périmètre A3-bis (scope strict)

- **Stripe API instrumentation** — `StripeMetricsTracker` (sync + async) wrappe les 7 appels SDK Stripe runtime : `payment_intents.create|capture|retrieve`, `refunds.create`, `transfers.create|retrieve`, `events.retrieve`, `webhooks.construct_event`. Classification d'erreurs Stripe → 9 statuts bornés (`success`, `invalid_signature`, `invalid_request`, `authentication`, `permission`, `rate_limited`, `connection`, `card_error`, `api_error`, `unknown`).
- **Webhook processing instrumentation** — `WebhookMetricsTracker` alimente `webhook_processing_total` + `webhook_processing_failures_total` + `webhook_processing_duration_seconds` sur les 4 outcomes : `accepted` (HMAC OK + DB insert + enqueue), `rejected` (signature/livemode/payload malformé), `replayed` (event_id dupliqué → 202 idempotent), `failed` (worker exception).
- **DLQ events instrumentation** — `DlqMetricsTracker` alimente `dlq_events_total{source, action}` (counter) sur 3 transitions : `enqueued` (processor → DLQ après retries exhaustés), `replayed` (admin replay OK), `replay_failed` (DLQ inexistante / event Stripe disparu). La gauge `dlq_jobs_total{queue}` (taille courante) reste alimentée par `BullMqMetricsService` (A3, QueueEvents listener).
- **Labels bornés** : `operation` / `status` (Stripe) + `event_type` / `outcome` (webhook) + `source` / `action` (DLQ). Aucun label PII / UUID / cardinalité explosive. `event_type` normalisé via whitelist `KNOWN_STRIPE_EVENT_TYPES` + pattern strict + fallback `unknown`.
- **Histogram buckets dédiés Stripe** : `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]s` (couvre p50 ~200 ms à timeouts longs Connect).

#### Décisions senior

- **DLQ counter vs gauge** — `dlq_events_total` ajouté comme **counter** distinct de la gauge `dlq_jobs_total` : sémantiques orthogonales (taille courante vs taux d'événements). PromQL différentié : `dlq_jobs_total > 10` pour seuils statiques, `rate(dlq_events_total[5m])` pour alertes burst.
- **Labels renommés** (`method`/`provider`/`type`/`result` → `operation`/`event_type`/`outcome`) avant déploiement prod — pas de breaking change observable.
- **`MetricsModule` `@Global()`** — les 3 trackers sont injectés dans 4 modules (Payments, MissionsCompletion, Photos, Auth via interceptor) sans coupler chaque module à un import explicite. Singleton registry conforme ADR-014.
- **Processor outcomes** : un job en retry incrémente `outcome=failed` à chaque tentative — visibilité retries dans le compteur. Transition DLQ finale tracée séparément via `dlq_events_total`. Pas de double comptage.

#### Tests (37 nouveaux)

- 13 tests `stripe-metrics.tracker.spec.ts` — sync/async, classification erreurs (9 types Stripe + fallbacks), cardinality whitelist, isolation multi-registry.
- 9 tests `webhook-metrics.tracker.spec.ts` — 4 outcomes émis, failures_total ciblé rejected/failed seulement, normalisation event_type (whitelist + pattern + injections SQL/JSON).
- 4 tests `dlq-metrics.tracker.spec.ts` — 3 actions + non-pollution gauge.
- 5 tests **intégration** `observability-metrics-a3bis.integration.spec.ts` — webhook accepted/rejected/replayed runtime, replay DLQ admin, replay DLQ inexistante.
- 6 tests `metrics.service.spec.ts` mis à jour pour les nouveaux labels.

#### Métriques livrées (A3 + A3-bis)

13 métriques `cleanconnect_*` exposées sur `/api/internal/metrics` :

| Famille | Métrique | Labels | Source |
|---|---|---|---|
| HTTP | `http_requests_total`, `http_request_duration_seconds` | `method`, `route`, `status` | A3 (interceptor) |
| BullMQ | `bullmq_jobs_total`, `bullmq_jobs_failed_total` | `queue`, `name`, `result`/`reason` | A3 (QueueEvents) |
| Stripe | `stripe_api_calls_total`, `stripe_api_failures_total`, `stripe_api_duration_seconds` | `operation`, `status` | **A3-bis** (tracker) |
| Webhook | `webhook_processing_total`, `webhook_processing_failures_total`, `webhook_processing_duration_seconds` | `event_type`, `outcome` | **A3-bis** (ingest + processor) |
| DLQ | `dlq_jobs_total` (gauge) + `dlq_events_total` (counter) | `queue` / `source`, `action` | A3 + **A3-bis** |

#### Gates locales

✅ `tsc --noEmit` (apps/api) · ✅ `eslint --max-warnings=0` (apps/api) · ✅ 26 suites / **369 unit tests** · ✅ 13 suites / **110 integration tests** (zéro régression Stripe/transfers/refunds/webhooks).

#### Definition of Done — Build A3-bis

Instrumentation runtime branchée sur tous les flux Stripe et webhook ✅ · `stripe_api_*` et `webhook_processing_*` réellement alimentées ✅ · `dlq_events_total` branché aux 3 transitions ✅ · 0 PII en labels ✅ · cardinalité bornée ✅ · CI locale verte ✅ · tests dédiés (37 nouveaux) ✅. **Bloque** : sign-off CTO Build A3-bis (puis Build B — OpenTelemetry / Grafana / BullBoard).

---

### Build — PRD-004 Ticket 4.1 Foundations A1+A2+A3 (Sprint 4) — 2026-05-12

🟢 **Couches Observabilité fondamentales opérationnelles** (Sentry + Pino redacté + Prometheus endpoint). PR #18 mergée. Tests : 337/337 unitaires verts, 95/95 intégration verts.

- **A1 Sentry** — `@sentry/node` v8 init pre-bootstrap, `tracesSampler` 100 % routes finance, `beforeSend` + `beforeBreadcrumb` redacteurs PII, `RequestIdMiddleware` + tag scope Sentry. 4 envs `SENTRY_DSN/ENVIRONMENT/RELEASE/TRACES_SAMPLE_RATE`. 80 tests unitaires `sanitize.spec.ts`.
- **A2 Pino hardening** — `REDACTION_PATHS` 3 classes (A/B/C) centralisés + `pinoLogFormatter` (deep sanitization recursive, bypass limitation `fast-redact` wildcards) + `traceId` injection via `customProps` + `requestId` correlation. 15 tests `redaction.spec.ts` (snapshot lock-in + payloads BullMQ).
- **A3 Prometheus foundation** — `prom-client` v15, registry isolé `cleanconnect_*` (8 métriques canoniques + Node runtime), `MetricsBearerGuard` (`timingSafeEqual` SHA-256), `HttpMetricsInterceptor` global (`normalizeRoute` cardinality), `BullMqMetricsService` (`QueueEvents` listener + `normalizeReason`). 2 envs `METRICS_ENABLED/BEARER_TOKEN` + Zod `superRefine` (crash boot prod si token absent). 28 tests métriques.

---

### Design — PRD-004 Ticket 4.1 Observabilité & Ops (Sprint 4) — 2026-05-12

🟡 **Phase Design ouverte sur Ticket 4.1 — aucune ligne de code runtime.**
PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.1 → §4.11. Validation CTO Design Ticket 4.1 requise pour passer en Build.

#### Décisions architecturales (4 ADRs)

- **[ADR-014](docs/adr/ADR-014-observability-architecture.md)** — 3 piliers stricts : **Sentry** (erreurs + APM) + **OpenTelemetry** (traces cross-service) + **Prometheus/Grafana** auto-hébergés (métriques techniques + queues + business). Sampling 10 % prod + override 100 % routes critiques (finance, webhooks). Corrélation triple `requestId` + `traceId` + `jobId`.
- **[ADR-015](docs/adr/ADR-015-bullmq-monitoring-dlq.md)** — **BullBoard** read-only derrière `JwtAccessGuard(ADMIN)` + 7 métriques `cleanconnect_bullmq_*` (queue depth, retries, stalled, DLQ size, processing lag) + DLQ visibility sans exposition payload brut.
- **[ADR-016](docs/adr/ADR-016-logging-redaction-strategy.md)** — Pino prod figé + redactor 3 classes (A=secrets 18 chemins, B=finance 7, C=PII 14) + corrélation IDs obligatoires + IP redactée par défaut + rétention 30/90/180 j selon type + RGPD conforme (UUID = pseudonyme CNIL).
- **[ADR-017](docs/adr/ADR-017-alerting-strategy.md)** — **Discord webhook** (`#ops-p0`, `#ops-p1`, `#ops-p2-p3`) temps réel + récap quotidien email/Discord (Resend) + matrice sévérité P0-P3 + escalade `@here`/`@on-call` + silence window auditable + templates sans PII (`sanitizeForAlert`).

#### Design technique (PRD §4.1 → §4.7)

- **Architecture observabilité** : diagramme single-process NestJS → 3 exports parallèles (Sentry, OTel/Sentry, Prometheus) + Pino stdout.
- **2 flux de référence tracés** : `POST /missions/:id/validate` mono-process + `POST /webhooks/stripe` cross-process (traceId continu HTTP → BullMQ worker).
- **Matrice flux × signaux** : 5 flux × {Prometheus, OTel, Pino} couverts.
- **Endpoints health/readiness/metrics** : `/healthz` + `/readyz` (public) + `/api/internal/metrics` + `/api/internal/queues` (Bearer interne firewall réseau Docker) + `/admin/queues/*` BullBoard + `/admin/observability/silence` (JWT ADMIN).
- **Conventions nommage** : préfixe `cleanconnect_<domain>_<entity>_<measure>_<unit>` + **19 métriques figées** Ticket 4.1.
- **Contrats observabilité** : `AlertEvent` schema (severity P0-P3 + kind enum + sanitize) + `WebhookDeadLetterView` (payloadHashTruncated, errorMessageSanitized, traceId) + RBAC matrix par endpoint.
- **3 dashboards Grafana** : D1 API Health + D2 BullMQ Queues + D3 Business Funnel (préparé 4.1, alimenté 4.5).
- **12 modules Nest réservés** (`observability/*` + `admin/observability/*`) pour Build.

#### Risk assessment Design (8 risques)

🟠 Fuite PII = 4/5 (`beforeSend` Sentry + `sanitizeForAlert` + `/metrics` Bearer + firewall) · 🟠 Surface attaquable = 4/5 (RBAC strict + BullBoard read-only + JWT) · 🟡 Saturation logs / Alert fatigue / Vendor Sentry / Régression perf = 3/5 (mitigés sampling + rétention + tuning + bench) · 🟡 Coût = 2/5 (~30 €/mois total).

#### Pré-revue sécurité

[`docs/security-reviews/2026-05-12-prd-004-observability-design-prereview.md`](docs/security-reviews/2026-05-12-prd-004-observability-design-prereview.md) — **0 Critical / 0 Important / 5 Suggestions / 18 Conforme**. 5 Conditions Build obligatoires : DPA Sentry + registre RGPD ; test redactor Pino exhaustif ; Sentry `beforeSend` filter PII ; auth Grafana via reverse proxy + `auth_request` API ; test OTel traceId cross-process.

#### TODO Build figé (20 items)

Cf. PRD §4.10 — séquence d'implémentation Build Ticket 4.1 (dépendances npm, env vars, init Sentry+OTel pre-bootstrap, `ObservabilityModule`, hooks BullMQ, `AlertingService`, silence Redis, Prometheus middleware, BullBoard read-only, redactor Pino, custom sampler, tests intégration `traceId` cross-process, dashboards Grafana JSON versionnés, `docker-compose.prod.yml` Prometheus+Grafana, `CLAUDE.md` update).

#### Definition of Done — Design Ticket 4.1

ADRs 014-017 rédigés ✅ · Architecture validée ✅ · Dashboards listés ✅ · Alerting défini ✅ · Sécurité validée (pré-revue 0/0) ✅ · 0 ligne runtime ✅. **Bloque** : sign-off CTO Design Ticket 4.1 (DoD PRD §4.11 dernière case).

---

### Discover — PRD-004 Hardening, Ops & Compliance (Sprint 4) — 2026-05-12

🟡 **Phase Discover ouverte — aucune ligne de code runtime.**
PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) — statut `DISCOVER_DRAFT`. Validation CTO requise pour passer en Design.

#### Périmètre proposé (5 tickets)

- **4.1 Observabilité & Ops** — Sentry + OpenTelemetry + dashboards p95/p99 + BullMQ monitoring + alerting DLQ.
- **4.2 Retry & Recovery BullMQ** — retry auto transfer (dette PRD-003), stuck job recovery, poison job isolation, safety-net cron, recovery playbooks.
- **4.3 Admin Tooling UI** — dashboard admin, transfers/refunds/DLQ/disputes monitors, audit timeline, traçabilité actions admin.
- **4.4 RGPD avancé** — `DELETE /users/me` (dette **L**), export utilisateur, `DELETE /admin/photos/:id` (dette **G**), webhook entrant Cloudinary (dette **I**), consent logs, Cloudinary deletion guarantees, retention audit.
- **4.5 Monitoring financier** — Stripe/DB reconciliation, stuck funds detector, payout anomalies, daily finance report, consistency invariants.

#### Décisions à arbitrer en Discover (9 Open Questions CTO)

OQ-1 Sentry seul vs Sentry+OTel ; OQ-2 Prometheus/Grafana maintenant ou plus tard ; OQ-3 BullBoard vs admin custom ; OQ-4 hard delete vs anonymisation `/users/me` ; OQ-5 export JSON seul vs ZIP+photos ; OQ-6 canal alerting Slack/email ; OQ-7 daily finance report email vs dashboard ; OQ-8 seuils d'alerte (stuck transfer, DLQ count, error rate) ; OQ-9 PRD-004 unique vs split 004A Ops / 004B Admin&RGPD.

#### Risk assessment

🔴 RGPD = 5/5 (DELETE users + export utilisateur + suppression photo touchent au cœur du droit à l'effacement et à la portabilité) ; 🟠 Sécurité = 4/5 (Sentry doit redacter PII, admin tooling expose des routes très sensibles) ; 🟠 Financier = 4/5 (retry transfer auto et reconciliation cron manipulent du cash réel) ; 🟠 Dette ops = 4/5 (sans 4.1/4.3, PRD-005 Disputes infaisable proprement) ; 🟡 Perf = 3/5, Disponibilité externe = 3/5, UX = 2/5, Coût = 2/5.

#### Recommandation ordre d'exécution

4.1 (observer) → 4.2 (automatiser) → 4.5 (contrôler) → 4.4 (se conformer) → 4.3 (confortifier admin). Cible tag : `v3.1.0-prd004` (ou split `v3.1.0-prd004a` + `v3.2.0-prd004b` si OQ-9 = split).

#### Dépendances PRD-003

Reprend explicitement les dettes G / I / L arbitrées CTO PR #13 + `debt-prd004-transfer-retry-queue` + `debt-prd004-orphan-cleanup` + suivi CodeRabbit DX.

#### Definition of Done — Discover

PRD instancié + 5 tickets + risques + métriques + OQ + dépendances + ordre d'exécution + zéro code runtime ✅. **Bloque** : sign-off CTO § DoD Discover dernière case.

---

### Verify — PRD-002 Missions & Géolocalisation (Ticket 2.3) — 2026-05-12

✅ **Sign-off CTO accordé — merge PR #4 autorisé.**
Rapport sécurité complet : [`docs/security-reviews/2026-05-12-prd-002-missions-build-verify.md`](docs/security-reviews/2026-05-12-prd-002-missions-build-verify.md).

#### Added — Tests Verify (21 nouveaux cas intégration + 16 unit)

- **`apps/api/test/integration/missions-verify.integration.spec.ts`** — couvre les **5 audits CTO obligatoires** :
  - **A** : idempotence accept (double POST même provider) — pas de double event ni de mutation, `updated_at` inchangé sur 2ᵉ POST.
  - **B** : race cancel vs accept — état final cohérent + erreur précise (`mission_cancelled`).
  - **C** : ADMIN voit `address.kind=FULL` ; logs Pino restent redacted (preuve runtime).
  - **D** : `MissionEvent` payload hygiene — refuse adresse complète + email + phone + token + jwt + password + authorization (8 cas négatifs + 1 cas positif).
  - **E** : race expiration vs accept — UPDATE conditionnels Postgres mutuellement exclusifs.
  - **+** RBAC complémentaire : `GET /missions/:id` sans token → 401, `POST /accept` sans token → 401, `GET /admin/missions` avec rôle CLIENT → 403.
- **`mission-event.types.spec.ts`** étendu : 16 nouveaux cas pour la nouvelle fonction `assertEventPayloadHygiene`.

#### Changed — Durcissements Verify (sans nouvelle feature)

- **`MissionsService.accept()`** post-race : distingue maintenant précisément `ACCEPTED → MISSION_ALREADY_ACCEPTED`, `CANCELLED → mission_cancelled`, `EXPIRED → mission_expired`, `PUBLISHED → MISSION_NOT_ELIGIBLE`. Plus aucun message d'erreur trompeur.
- **`toInvalidStateError()`** produit un `reason` sémantique stable (`mission_cancelled` / `mission_expired` / `mission_already_accepted`) au lieu de la forme brute `CANCELLED->ACCEPTED`. Permet un mapping i18n stable côté front/mobile.
- **`assertNoAddressLeak`** renommée en **`assertEventPayloadHygiene`** (alias rétrocompat) avec périmètre élargi : refuse désormais clés `email*`, `phone*`, `mobile`, `telephone`, `password*`, `token*`, `jwt`, `authorization`, `apiKey`, `secret*` en plus des données d'adresse.
- **`AllExceptionsFilter`** : propage les détails métier additionnels du body de l'exception (ex: `reason`) sans écraser la forme principale (`statusCode`, `error`, `message`, `path`, `timestamp`). Whiteliste anti-fuite.

#### Stats finales Sprint 2

- **63 tests unit verts** (46 Build + 17 Verify §D) — `pnpm --filter @cc/api test`
- **51 tests intégration verts** (16 Auth + 1 rate-limit + 13 Build + 21 Verify) — `pnpm --filter @cc/api run test:integration`
- **typecheck + lint propres** — `pnpm typecheck && pnpm lint`
- **Aucune nouvelle dette introduite** — les 4 dettes Build acceptées (`debt-matching-async-queue`, `debt-listing-expiration-queue`, `debt-mission-distance-display`, `debt-coverage-report`) restent inchangées.

---

### Build — PRD-002 Missions & Géolocalisation (Ticket 2.2)

Implémentation complète du cycle de vie mission (CREATE → PUBLISH → matching PostGIS → ACCEPT) en respectant les 7 contraintes CTO Build (audit `MissionEvent`, `missionNumber` immuable serveur, matching paginé/borné, masquage adresse pré-acceptation, exclusions matching, transitions via `assertMissionTransition`, zéro logique en controllers).

#### Added — API NestJS (`apps/api/src/modules/missions/`)

- **HTTP**
  - `POST /api/v1/missions` (CLIENT) — création brouillon + géocodage BAN ou GPS mobile.
  - `POST /api/v1/missions/:id/publish` (CLIENT owner) — `DRAFT → PUBLISHED`, calcule `listingExpiresAt`, déclenche le matching.
  - `POST /api/v1/missions/:id/accept` (PRESTATAIRE) — lock optimiste SQL first-wins (ADR-005), `200 ACCEPTED` ou `409 MISSION_ALREADY_ACCEPTED`.
  - `DELETE /api/v1/missions/:id` (CLIENT owner) — `DRAFT/PUBLISHED → CANCELLED`.
  - `GET /api/v1/missions/mine` (CLIENT) — listing paginé cursor-based.
  - `GET /api/v1/missions/proposed` (PRESTATAIRE) — missions matchées non expirées.
  - `GET /api/v1/missions/:id` — RBAC + masquage adresse via `mission-address.policy`.
  - `GET /api/v1/admin/missions` (ADMIN) — listing global paginé.
- **Domaine pur** : `mission-state.machine` (transitions strictes typées), `mission-address.policy` (masquage CP partiel), `mission-event.types` (`assertNoAddressLeak` récursif).
- **Services** : `MissionsService`, `MissionNumberService` (`CC-YYYY-XXXXXXXX`), `MissionEventService` (audit), `GeocoderService` (BAN + retry/timeout, fallback GPS), `MatchingService` (PostGIS `ST_DWithin`), `MissionViewService` (sérialisation + policy).
- **Repository** : `missions.repository.ts` — `$queryRaw` PostGIS pour insertion `addresses.location` (geography(Point, 4326)), matching paginé borné par `MATCHING_MAX_PROVIDERS` (défaut 50), UPDATE conditionnels atomiques.
- **Errors** : `missions.errors.ts` — codes stables `MISSION_NOT_FOUND / FORBIDDEN / INVALID_STATE / ALREADY_ACCEPTED / NOT_ELIGIBLE / GEOCODING_FAILED / VALIDATION_FAILED`.
- **Pino redactor** étendu (`app.module.ts`) : `req.body.address.street`, `req.body.address.location`, `*.street`, `*.location.lat/lng`.

#### Added — Schéma DB

- **Migration** `20260512200000_prd002_mission_events_user_status` (additive, non destructive) :
  - `users.verified_at TIMESTAMPTZ DEFAULT NOW()` — null ⇒ exclusion matching.
  - `users.suspended_at TIMESTAMPTZ NULL` — non-null ⇒ exclusion matching.
  - Table `mission_events` (`id, mission_id, type, actor_user_id?, payload?, created_at`) + index `(mission_id, created_at)` et `(type)`.

#### Added — Shared types (`packages/shared-types/src/zod/mission.ts`)

- `missionAddressInputSchema`, `missionViewSchema`, `missionListQuerySchema`, `missionListResponseSchema`, `missionAddressViewSchema` (discriminated `MASKED | FULL`), `missionEventTypeSchema`, `missionErrorCodeSchema`.

#### Added — Tests

- **Unit (46 verts)** : state machine, address policy, no-address-leak, mission number, geocoder.
- **Integration (33 verts, dont 13 missions)** sur Postgres+PostGIS éphémère :
  - flow nominal CREATE → PUBLISH → ACCEPT
  - exclusion matching : suspendus / non vérifiés / soft-deleted / hors rayon
  - masquage adresse pré-acceptation puis FULL post-ACCEPT
  - **race accept first-wins** (`Promise.all` 2 prestataires) → `[200, 409]` garantis
  - RBAC : autre CLIENT → 403, PRESTATAIRE sur POST → 403, ADMIN voit FULL
  - state machine : publish post-CANCEL → 409
  - listing expiration : `expireIfStillProposed` après backdate → `EXPIRED` + audit
  - Validation Zod : `endAt < startAt` → 400

#### Configuration

- `MISSION_LISTING_TTL_MS` (défaut 15 min, validé `[1s, 24h]`).
- `MATCHING_MAX_PROVIDERS` (défaut 50, max 500).
- `BAN_BASE_URL` (défaut `https://api-adresse.data.gouv.fr`) + `BAN_TIMEOUT_MS` (défaut 5 s).

#### Technical debt (Build, suivi)

| Slug | Description | Priorité |
|---|---|---|
| `debt-matching-async-queue` | Matching synchrone dans `publish()` ; à basculer en BullMQ producer/consumer si volume > 100 missions/min | M |
| `debt-listing-expiration-queue` | `expireIfStillProposed` invocable mais pas branché sur job BullMQ delayed ni cron — à câbler avant ouverture marketplace publique | M |
| `debt-mission-distance-display` | `MaskedMissionAddress.approximateDistanceKm` renvoyé à 0 (UI = "à proximité"). Calcul réel (croisement adresses) en future itération | L |
| `debt-coverage-report` | Pas de seuil `coverage >= 80%` enforced en CI | L |

#### Documentation

- PRD : [`docs/prd/PRD-002-missions-geolocalisation.md`](docs/prd/PRD-002-missions-geolocalisation.md) v0.3 (Build) — DoD §5.7 cochée sauf audit reviewer + sign-off CTO.

---

## [v0.1.0-auth-foundation] — 2026-05-12

Premier vertical slice livré de bout en bout via la méthode [BMAD-light](docs/method/BMAD.md).
Auth = fondation officielle de toute la plateforme : rôles, sessions, guards, bootstrap mobile, sécurité JWT, rate limiting, refresh rotation.

### Added

- **API NestJS** (`apps/api/src/modules/auth/`) — module `Auth` complet :
  - `POST /api/v1/auth/signup` (CLIENT/PRESTATAIRE, ADMIN exclu), `/login`, `/refresh`, `/logout`, `GET /me`.
  - `JwtAccessStrategy` + `JwtAccessGuard` + `RolesGuard` séparés (cf. [ADR-004](docs/adr/ADR-004-auth-tokens-strategy.md)).
  - `bcrypt` cost 10 pour passwords ; refresh tokens opaques 48 bytes hachés en SHA-256 en DB.
  - Rotation transactionnelle (`prisma.$transaction`) + cascade revoke sur replay détecté.
  - `ConditionalThrottlerGuard` — rate limiting per-route (signup 5/min, login 10/min, refresh 30/min) avec bypass `DISABLE_THROTTLE` interdit en production (crash boot `env.ts`).
- **Mobile Expo** (`apps/mobile/src/features/auth/`) — Zustand store + `expo-secure-store` + écrans Login/Signup + `AuthBootstrap` au démarrage + `/auth/me` source de vérité (zéro JWT decode client-side).
- **Schémas Zod partagés** (`packages/shared-types/src/zod/auth.ts`) — DTOs `.strict()` + blocklist mots de passe.
- **Migration Prisma** `20260512130000_pr001_refresh_tokens_and_user_names` — modèle `RefreshToken` + `firstName`/`lastName` sur `User`.
- **Documentation** :
  - PRD : [`docs/prd/PRD-001-auth-jwt.md`](docs/prd/PRD-001-auth-jwt.md) (v0.5, statut `DONE`).
  - ADR : [`docs/adr/ADR-004-auth-tokens-strategy.md`](docs/adr/ADR-004-auth-tokens-strategy.md).
  - Pré-revue Design : [`docs/security-reviews/2026-05-12-prd-001-auth-design-prereview.md`](docs/security-reviews/2026-05-12-prd-001-auth-design-prereview.md).
  - **Audit final** : [`docs/security-reviews/2026-05-12-prd-001-auth-verify.md`](docs/security-reviews/2026-05-12-prd-001-auth-verify.md) — Verdict ✅ Merge OK (0 Critique / 0 Important non traité).
- **Tests** :
  - API unit : 24/24 (`auth.service`, `token.service`, `password.service`, `health`).
  - API intégration : 20/20 (`auth-flow` 19 scénarios CTO + `auth-rate-limit` 1 scénario throttler).
  - Mobile unit : 18/18 (`auth.store`, `auth-errors`).
- **CI** : 3 jobs verts (Quality / Integration Postgres+Redis / Build Docker).

### Fixed

Faux-verts détectés et corrigés pendant la phase Verify (Ticket 1.6) :

- **Double pipe global** dans `apps/api/src/main.ts` — `ValidationPipe` (class-validator) + `ZodValidationPipe` (APP_PIPE) cumulaient et rejetaient les props déjà validées par Zod. Retrait du `ValidationPipe` ; `ZodValidationPipe` reste l'unique pipe global, `.strict()` Zod fait whitelist.
- **`jest.integration.config.ts`** — `testPathIgnorePatterns` héritait du config unitaire et excluait `*.integration.spec.ts` → faux-vert CI (0 tests). Override explicite + `setupFiles` (`jest-env.setup.ts`) + `testTimeout: 120s`.

### Technical debt (suivi post-merge)

| Slug | Description | Priorité |
|---|---|---|
| `debt-throttle-composite` | Clé throttler IP-only ; IP+email reporté | M |
| `debt-password-blocklist` | Étendre la blocklist vers OWASP top 10k | M |
| `debt-error-envelope` | Clients consomment `error` field (envelope non standardisée RFC 7807) | L |
| `debt-mobile-ui-polish` | DA finale post-PRD design | M |
| `debt-mobile-active-role` | `AsyncStorage` pour la préférence de rôle, MMKV reporté | L |
| `debt-mobile-component-tests` | Tests RN composants (Detox / Maestro) | M |
| `debt-integration-coverage-report` | Gate coverage intégration | L |
| S1 — Swagger Bearer nominatif `@ApiBearerAuth('access-jwt')` | DX | L |
| S2 — `/logout` throttle + doc explicite ADR-004 | DX/sécu | L |

### Stack figée

- NestJS 10 + Prisma 5 + Postgres 16 + PostGIS 3.4 + Redis 7
- nestjs-zod + nestjs-pino + @nestjs/throttler + @nestjs/jwt + passport-jwt
- Expo SDK 54 + React Native + Zustand + expo-secure-store + react-hook-form + zod
- Turborepo + pnpm workspaces

---

*Référence méthode : [BMAD-light](docs/method/BMAD.md) — toutes les features suivent les 4 phases Discover → Design → Build → Verify.*
