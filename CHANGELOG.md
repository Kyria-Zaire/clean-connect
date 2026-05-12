# Changelog

Toutes les modifications notables apportées à Clean Connect sont consignées dans ce fichier.

Le format est inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

Chaque entrée référence le PRD pilote (cf. [`docs/prd/README.md`](docs/prd/README.md))
et le rapport sécurité associé (`docs/security-reviews/`).

---

## [Unreleased]

### Build — PRD-004 Ticket 4.1 Build B (Sprint 4) — 2026-05-12

🟢 **Couche observabilité runtime ops complète : OpenTelemetry + BullBoard + Alerting + Grafana.**
PRD : [`docs/prd/PRD-004-hardening-ops-compliance.md`](docs/prd/PRD-004-hardening-ops-compliance.md) §4.1 (Build B). ADR-014 / ADR-015 / ADR-016 / ADR-017.

#### Périmètre Build B (scope strict CTO)

5 commits atomiques :

- **B1 — OpenTelemetry SDK** : SDK NodeJS dédié `apps/api/src/instrumentation.ts` chargé en tout premier (avant Nest / Sentry / Express → require-hook auto-instrumentations OK). Cohabitation Sentry v8 via `skipOpenTelemetrySetup: true` + `SentrySpanProcessor` + `SentryPropagator` (W3C TraceContext + Sentry baggage). Helper `bullmq-trace.ts` (injectTraceContext / runWithExtractedTraceContext) propage `_otel.traceparent` HTTP → BullMQ worker. Câblé sur `PaymentsWebhookService` (ingest + replay), `AutoReleaseService.enqueueDelayedJob`, `StripeWebhookProcessor.process`, `AutoReleaseProcessor.process`.
- **B2 — BullBoard read-only sécurisé** : monté conditionnellement (`BULL_BOARD_ENABLED=false` par défaut) sur `/api/internal/queues`. `readOnlyMode: true` sur chaque `BullMQAdapter` → BullBoard refuse retry/promote/delete côté serveur. Auth en 2 voies : `INTERNAL_BEARER_TOKEN` (timingSafeEqual) OU JWT ADMIN. Sanitization middleware wrap `res.json` + `res.send` → `deepSanitize` defense-in-depth.
- **B3 — AlertingService + Discord notifier** : service `@Global` avec API `emit(AlertPayload)`. Routing P0/P1 immédiat (cooldown 5min par `<severity>:<kind>`) / P2 buffer agrégé (flush 60s, batch ≤ 10 embeds) / P3 logs only. `sanitizeForAlert` = `deepSanitize` + `redactSecretsInString` recursive. `DiscordNotifier` POJO testable (fetchImpl injectable), AbortSignal.timeout(5s), `send` retourne `false` sans throw sur 4xx/5xx/network. `emit()` swallow toute erreur notifier (contrat strict : alerting ne casse jamais le métier).
- **B4 — Grafana provisioning** : 3 dashboards JSON pre-loaded (folder "Clean Connect") + datasource Prometheus auto-provisionnée. `docker-compose.observability.yml` (Prometheus v2.55 + Grafana v11.3, network intra-cluster). `ops/prometheus/prometheus.yml` scrape `/api/internal/metrics` avec `METRICS_BEARER_TOKEN` injecté.
- **B5 — Documentation** : PRD §4.13 + ce CHANGELOG + TODO(debt) explicites.

#### Métriques nouvelles ou ré-instrumentées

| Métrique | Type | Build | Labels | Source instrumentation |
|---|---|---|---|---|
| `cleanconnect_*` (déjà existantes A3+A3-bis) | — | A3 | — | inchangées |
| `bullmq.process <queue>` (span OTel) | span | B1 | messaging.system / destination / operation / bullmq.job.name | `runWithExtractedTraceContext` (helper) |

Aucune nouvelle métrique Prometheus créée — Build B câble l'existant + ajoute les **traces distribuées**.

#### Dashboards Grafana provisionnés

| Dashboard | UID | Panels |
|---|---|---|
| `cc-api-health` | API Health | latency p50/p95/p99, RPS by status, 5xx rate, heap/RSS, event-loop lag, CPU |
| `cc-stripe-webhooks` | Stripe & Webhooks | API calls/op, failures/op×status, latency p95/op, webhook outcomes, failures by event_type, DLQ gauge + delta |
| `cc-bullmq` | BullMQ & Queues | jobs completed/failed by queue, state cumulative, webhook latency p95, DLQ size stat, DLQ events/min |

#### Alerts définis (côté `AlertKind` enum)

5 alerts obligatoires CTO (déclencheurs cron `AlertChecker` reportés Ticket 4.2) :
- `webhook_failed_rate`
- `dlq_growth`
- `stripe_api_failure_spike`
- `bullmq_failed_jobs`
- `metrics_endpoint_down` (alertmanager Prometheus side — debt)

6 alerts réservés futures itérations (PRD-004 Tickets 4.2 → 4.5).

#### Variables d'environnement ajoutées (env.ts Zod)

| Var | Défaut | Crash boot si |
|---|---|---|
| `OTEL_ENABLED` | `false` | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optionnel | — |
| `OTEL_SERVICE_NAME` | `clean-connect-api` | — |
| `OTEL_TRACES_SAMPLER_RATIO` | `0.1` | — |
| `BULL_BOARD_ENABLED` | `false` | `=true` en prod sans `INTERNAL_BEARER_TOKEN` |
| `INTERNAL_BEARER_TOKEN` | optionnel | — |
| `ALERTING_ENABLED` | `false` | `=true` sans `DISCORD_WEBHOOK_URL` |
| `DISCORD_WEBHOOK_URL` | optionnel | regex Discord stricte |
| `ALERTING_COOLDOWN_SECONDS` | `300` | — |

#### Décisions techniques

- **OTel v1 vs v2** — pin sur `@opentelemetry/sdk-node@^0.57.0` / `auto-instrumentations-node@^0.55.0` / `core@^1.30.0` car Sentry v8 utilise OTel v1 sous le capot. Sentry v10 (qui supporte OTel v2) hors-scope (gros impact A1).
- **Pas de package `instrumentation-bullmq`** — community uniquement, non audité. Préféré un helper manuel `bullmq-trace.ts` (~110 lignes, testé exhaustivement, propage W3C TraceContext via field `_otel.*` du payload). Idempotent sur replay DLQ.
- **BullBoard via `MiddlewareConsumer`** — auth/sanitize middlewares Nest chaînés avant le router Express BullBoard. Permet d'utiliser `JwtService` + `deepSanitize` sans wrap Controller artificiel.
- **AlertingService swallow** — `emit()` ne throw JAMAIS au caller. Une boucle d'erreur Discord ne doit pas casser le webhook Stripe / un job BullMQ.
- **Auto-instrumentations désactivées** — `fs` (PII paths), `dns` (cardinality), `net` (low-level bruit). Routes `/metrics`, `/healthz`, `/readyz` ignorées par http-instrumentation (anti-bruit + perf).
- **Sanitization Class A étendue** — `idempotencykey` + `idempotency_key` ajoutés à `CLASS_A_KEY_PATTERNS` (camelCase manquant — couvrait uniquement `idempotency-key` kebab-case).

#### Tests (52 nouveaux)

- **B1** — 13 tests `bullmq-trace.spec.ts` : immutability, idempotence, parent-child linkage, error span, no-PII attribute audit.
- **B2** — 7 tests `bullboard-auth.middleware.spec.ts` (401/403/Internal/JWT/timingSafe) + 6 tests `bullboard-sanitize.middleware.spec.ts` (json/send/Buffer/HTML/Stripe leak).
- **B3** — 11 tests `sanitize-alert.spec.ts` (truncation, key-based + regex inline, cap context) + 7 tests `discord.notifier.spec.ts` (POST format, 4xx/5xx/network no-throw, batch cap 10) + 8 tests `alerting.service.spec.ts` (no-op, P0 dispatch, P2 buffer+flush, P3 log-only, cooldown, sanitize, swallow).

**Total avant Build B** : 369 unit / 110 integration.
**Total après Build B** : 421 unit / 110 integration (aucune régression).

#### Sécurité (vérifications CTO)

- ✅ Aucune PII dans les spans OTel (audit `no userId/missionId/paymentIntentId on span` testé)
- ✅ Aucun secret dans BullBoard (defense-in-depth `deepSanitize` sur `res.json`/`res.send`)
- ✅ Aucun secret dans Discord (defense-in-depth `sanitizeForAlert` = `deepSanitize` + `redactSecretsInString`)
- ✅ `/api/internal/queues` protégé JWT ADMIN + `INTERNAL_BEARER_TOKEN` (timingSafeEqual)
- ✅ `/api/internal/metrics` inchangé (Build A3 Bearer guard)
- ✅ BullBoard `readOnlyMode: true` strict côté serveur
- ✅ OpenTelemetry découplé du métier (uniquement helper + bootstrap, aucune coupling Payments/Photos/Auth)
- ✅ Pas de dépendance circulaire Nest (`AlertingModule` et `MetricsModule` `@Global`)

#### TODO(debt) (explicite, non bloquant pour merge)

| Debt | Source | Ticket cible |
|---|---|---|
| `alerting-cron-checker` | AlertingService prêt à recevoir des emit() mais aucun cron qui lit les counters et déclenche les 5 alerts | PRD-004 Ticket 4.2 |
| `alerting-retry-policy` | DiscordNotifier ne retry pas en cas de 5xx — P0 perdu si Discord indispo | PRD-004 Ticket 4.2 |
| `alerting-email-fallback` | SendGrid/Postmark fallback si Discord down | PRD-004 Ticket 4.2 |
| `bullboard-transfers-refunds-queues` | Files BullMQ `transfers` / `refunds` n'existent pas encore (tournent sync dans webhook processor) — exposées dans ADR-015 | PRD-004 Ticket 4.2 (retry queue) |
| `tempo-otlp-grafana` | Datasource Tempo + link traces ⇄ dashboards | PRD-004 Build C ou Ticket 4.2 |
| `alertmanager-metrics-endpoint-down` | Alertmanager rules YAML (impossible à détecter depuis le service lui-même) | Infra cible prod |
| `bullmq-bullboard-payload-content-type-recompute` | BullBoardSanitizeMiddleware réécrit le body — Content-Length recalculé par Express, à vérifier sous prod load | PRD-004 Verify |

#### Périmètre EXCLU (renvoyé Build C ou autre ticket)

- ❌ Cron `AlertChecker` qui déclenche réellement les 5 alerts (Ticket 4.2 — retry & recovery)
- ❌ OpenAPI changes (aucun endpoint REST ajouté côté API publique)
- ❌ Loki agrégation logs Pino
- ❌ Tempo cluster collector (config + dashboard intégration)
- ❌ Mobile / Admin observability (out-of-scope ticket 4.1)

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
