# ADR-014 — Architecture d'observabilité : Sentry + OpenTelemetry + Prometheus/Grafana

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-014` |
| **Titre** | Architecture observabilité production : Sentry (erreurs + APM) + OpenTelemetry (traces) + Prometheus/Grafana (métriques techniques + queues) |
| **Statut** | `Proposed` (Design Ticket 4.1) |
| **Date** | 2026-05-12 |
| **Auteur** | `architecte-api` + `ingenieur` (observability) + `senior-dev` |
| **PRD lié** | `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.1 |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Clean Connect est en `RELEASE_CANDIDATE` (PRD-003 — `v3.0.0-prd003`). Aucune observabilité runtime n'est branchée :

- pas de capture d'exception centralisée (`AllExceptionsFilter` n'envoie qu'une réponse HTTP, ne notifie personne),
- pas de tracing distribué (`POST /payments/intent` → DB → Stripe → BullMQ → handler webhook : pas de timeline),
- pas de métriques perf (p95/p99 endpoints, queue depth, retry counts, BullMQ stalled, DLQ growth),
- pas de corrélation `requestId` / `traceId` / `jobId` (impossible de relier un appel HTTP client à son job BullMQ asynchrone).

PRD-004 OQ-1 a tranché **Sentry + OpenTelemetry** (les deux, pas l'un ou l'autre) et OQ-2 a tranché **Prometheus + Grafana maintenant** (auto-hébergé). Cette ADR fige l'architecture et la frontière fonctionnelle entre ces trois piliers.

---

## 2. Décision

### 2.1 Trois piliers, trois responsabilités strictes

| Pilier | Outil retenu | Responsabilité exclusive | Sampling |
|---|---|---|---|
| **Erreurs + APM applicatif** | **Sentry** (`@sentry/node` + `@sentry/profiling-node`) | Capture exceptions non gérées + warnings métier critiques (`paymentFailed`, `webhookDLQ`) + APM transactions HTTP (p50/p95/p99) | `tracesSampleRate=0.1` prod, `0.5` recette, `1.0` dev (cf. §2.5) |
| **Traces distribuées** | **OpenTelemetry SDK Node** (`@opentelemetry/sdk-node`) + exporter OTLP/HTTP vers **Sentry** (via `@sentry/opentelemetry`) | Spans détaillés cross-service : controller → service → Prisma → Stripe → BullMQ producer → BullMQ consumer | Idem Sentry (un seul sampler) |
| **Métriques techniques + queues** | **Prometheus** (scrape `/metrics`) → **Grafana** | Counters / gauges / histograms : queue depth, jobs/min, retry count, stalled jobs, DLQ size, transfer success rate, capture latency | N/A (toutes les métriques, agrégation côté Prometheus) |

**Règle fondamentale** : **un signal = un pilier**. Pas de duplication erreurs Sentry ↔ Prometheus, pas de traces Sentry ↔ traces Prometheus.

### 2.2 Stack technique précise

```
NestJS app (apps/api)
  │
  ├── @sentry/node@^8                    ─→ Sentry SaaS (région UE — Frankfurt)
  ├── @sentry/profiling-node@^8          ─→ idem (profiling production)
  │
  ├── @opentelemetry/sdk-node@^0.55      ─→ exporter OTLP/HTTP vers Sentry
  ├── @opentelemetry/auto-instrumentations-node
  │     (http, express, nestjs-core, pg, ioredis, undici/fetch)
  │
  ├── prom-client@^15                    ─→ scrape Prometheus
  │     expose /api/internal/metrics
  │     (Bearer token interne, JAMAIS public)
  │
  └── nestjs-pino (déjà installé)        ─→ stdout JSON → conteneur Docker → vector/promtail → Loki (futur)
```

**Prometheus + Grafana** : auto-hébergés sur le même VPS prod (containers Docker) — **2 conteneurs supplémentaires**. Stockage Prometheus = 15 j de rétention (suffisant pour debug, pas pour audit long terme — les logs financiers restent dans Stripe + DB).

### 2.3 Endpoints d'observabilité

| Route | Auth | Usage | Format |
|---|---|---|---|
| `GET /healthz` | Public | Liveness Docker / k8s healthcheck | `{ status: 'ok', uptime, version, env }` |
| `GET /readyz` | Public | Readiness : DB OK + Redis OK + Stripe reachable | `{ status, services: { database, redis, stripe } }` (existant) |
| `GET /api/internal/metrics` | Bearer `OBSERVABILITY_TOKEN` (env var, rotation manuelle) | Scrape Prometheus | OpenMetrics text format |
| `GET /api/internal/queues` | Bearer `OBSERVABILITY_TOKEN` | Lecture brute BullMQ (debug ops) — cf. ADR-015 | JSON |

> **Critique** : `/metrics` n'est **jamais** public — il expose le nom de toutes les queues, payloads de label (mission ids hashés), counters internes. Bearer token côté **réseau Docker interne uniquement** (firewall VPS : port `9090` Prometheus ouvert uniquement sur l'IP du conteneur Grafana).

### 2.4 Corrélation IDs (la base du diagnostic)

Toute requête HTTP entrante et tout job BullMQ doivent porter **3 identifiants** dans leurs logs et leurs spans :

| ID | Source | Durée de vie | Format |
|---|---|---|---|
| `requestId` | Middleware `nestjs-pino` (déjà actif) — header `x-request-id` ou UUID v4 généré | Durée d'une requête HTTP | UUID v4 |
| `traceId` | OTel propagator (`@opentelemetry/api`) — créé au point d'entrée, propagé via `traceparent` header (W3C Trace Context) | Bout-en-bout (HTTP → BullMQ → BullMQ consumer) | 128 bits hex (32 chars) |
| `jobId` | BullMQ — `job.id` ou idempotency key déterministe (ex `transfer-mission-<missionId>`) | Durée d'un job (peut être > 1 heure pour les delayed) | String |

**Règle de propagation** :
- Le **producer** BullMQ (`queue.add`) injecte `{ requestId, traceId }` dans le `data` du job.
- Le **consumer** BullMQ (`@Process()`) extrait `{ requestId, traceId }` du `data` et les remet dans le contexte logger Pino + crée un span OTel enfant.
- Cela permet de cliquer dans Sentry sur un span HTTP `POST /missions/:id/validate` et voir le span enfant `outbound-transfer.create` exécuté 12 secondes plus tard dans le worker.

### 2.5 Stratégie sampling

| Environnement | `tracesSampleRate` Sentry/OTel | `profilesSampleRate` Sentry | Justification |
|---|:-:|:-:|---|
| `development` | `1.0` (100 %) | `1.0` | dev local, on veut tout voir |
| `recette` | `0.5` (50 %) | `0.1` | QA — couverture suffisante, coût SaaS modéré |
| `preprod` | `0.2` (20 %) | `0.1` | charge réelle, échantillon représentatif |
| `production` | `0.1` (10 %) **+** `tracesSampler` custom | `0.05` | priorité au volume bas, **mais** override sampler pour échantillonner **100 %** des transactions critiques (cf. ci-dessous) |

**Custom sampler prod** (`tracesSampler` Sentry) :

```typescript
// Pseudo — à figer en Build, pas du code runtime ici
tracesSampler: (samplingContext) => {
  const path = samplingContext.transactionContext?.name
  // 100 % des routes finance + webhooks
  if (path?.startsWith('POST /v1/webhooks/stripe')) return 1.0
  if (path?.startsWith('POST /v1/payments/intent')) return 1.0
  if (path?.startsWith('POST /v1/missions/') && path.endsWith('/validate')) return 1.0
  if (path?.startsWith('POST /v1/missions/') && path.endsWith('/complete')) return 1.0
  if (path?.startsWith('POST /v1/admin/payments/') && path.endsWith('/refund')) return 1.0
  // 10 % du reste
  return 0.1
}
```

**Critères de mise sous échantillon 100 %** : tout endpoint qui touche à de l'argent ou qui peut bloquer un utilisateur. Tout le reste reste à 10 %.

### 2.6 Dashboards Grafana figés (3 dashboards principaux)

| # | Dashboard | Audience | Sources | Refresh |
|---|---|---|---|---|
| **D1** | **API Health** | ops + CTO | Prometheus (`prom-client`) + Sentry transactions | 30 s |
| **D2** | **BullMQ Queues** | ops | Prometheus (cf. ADR-015) | 15 s |
| **D3** | **Business Funnel** (mission lifecycle, payment, transfer, refund) | CTO + finance | Prometheus + Postgres exporter (lecture aggregée) | 1 min |

Détail D1, D2, D3 dans le PRD-004 §4.6.

### 2.7 Logs : hors-scope de cette ADR

Les logs Pino structurés JSON restent **gérés à part** (ADR-016). Ils ne sont **pas** envoyés à Sentry (anti-pattern : Sentry n'est pas un log aggregator) ni à Prometheus (Prometheus ≠ logs). Ils sont écrits sur `stdout` Docker, lus par Vector ou Promtail (Ticket 4.1 ou plus tard), agrégés vers Loki ou un log aggregator SaaS.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Sentry seul** (sans OTel, sans Prometheus) | Sentry seul donne erreurs + APM HTTP, mais **traces distribuées cross-service** (HTTP → BullMQ job 12 s plus tard) limitées sans OTel SDK propre. Et pas de métriques queue (queue depth, stalled jobs) — Prometheus reste nécessaire. |
| **Datadog APM all-in-one** | Coût 5-10× supérieur à Sentry pour une équipe small. Vendor lock-in profond. Refusé OQ-1. |
| **OpenTelemetry seul + collector self-host** (Grafana Tempo + Loki + Prometheus) | Capable, mais coût opérationnel d'hébergement (3 services à maintenir) > bénéfice MVP. À reconsidérer si la facture Sentry SaaS dépasse 200 €/mois. |
| **Highlight.io / PostHog observability** | Encore jeune côté Node backend. Sentry a plus de maturité sur l'écosystème NestJS. |
| **New Relic / Honeycomb** | Coûteux pour le scope. Stack pas familière à l'équipe. |
| **Prometheus uniquement (sans Sentry)** | Manque la capture d'erreur applicative (stack traces, breadcrumbs, contexte utilisateur) — Prometheus traite des nombres, pas des évènements riches. |
| **Sentry + Prometheus sans OTel** | Possible mais perd les spans Prisma, ioredis, undici fine-grain. OTel auto-instrumentation est gratuit en effort et donne un détail inégalé. |
| **`Express middleware` custom à la place d'OTel** | Réinventer la roue + maintenir + risque de manquer des spans (cross-promise, jobs, etc.). |

---

## 4. Conséquences

### Positives

- **Visibilité bout-en-bout** : un incident `POST /webhooks/stripe → DLQ` peut être tracé en un clic dans Sentry, avec le span Stripe → DB → BullMQ producer.
- **MTTD < 5 min** : alertes Sentry sur les erreurs + alertes Grafana sur métriques techniques (cf. ADR-017).
- **MTTR réduit** : `requestId` corrèle logs Pino ↔ trace Sentry ↔ métrique Prometheus pour le même incident.
- **Pas de vendor lock-in dur** : OTel est standard, exporter swappable (Sentry → Tempo + Grafana le jour où on self-host).
- **Coût maîtrisé MVP** : Sentry team plan ~26 €/mois + Prometheus/Grafana auto-hébergés (compris dans VPS existant) = ~30 €/mois total au lancement.

### Négatives / coûts assumés

- **3 stacks à apprendre** pour la team (Sentry, OTel, Prom/Grafana). Compensé par l'auto-instrumentation OTel (peu de code à écrire).
- **Overhead runtime** : `@sentry/profiling-node` ajoute ~3-5 % CPU. `@opentelemetry/sdk-node` ajoute ~1-2 % de latence sur les requêtes tracées. Acceptable avec sampling 10 % prod.
- **Surface attaquable accrue** : `/metrics` doit être strictement protégé (Bearer token + firewall réseau). Une fuite expose la structure interne (noms de queue, taux d'erreur métier, etc.). Mitigé par ADR-017 + revue sécu.
- **Dette de revue après J+30** : il faudra ajuster les seuils d'alerte avec les vraies données prod (cf. ADR-017 §5).
- **Coût Sentry à terme** : team plan = 100k events/mois. Si dépassement → upgrade Business (~80 €/mois). Métrique à surveiller.

### Neutres (à surveiller)

- **Vendor Sentry SaaS** : DPA signé + région UE (Frankfurt) → conforme RGPD. À documenter dans le registre DPO.
- **Prometheus retention 15 j** : si on a besoin de plus long terme, ajouter Thanos ou Cortex (PRD-005+).
- **OTel exporter SDK** : `@sentry/opentelemetry` est en GA depuis Sentry SDK v8. Suivre les CHANGELOGs Sentry.

---

## 5. Suivi

- [ ] PR Build qui ajoute les SDKs + l'initialisation dans `apps/api/src/main.ts`
- [ ] PR Build qui ajoute le module `apps/api/src/modules/observability/`
- [ ] PR Build qui ajoute les dashboards JSON Grafana versionnés (`docs/ops/grafana/`)
- [ ] PR Build qui ajoute le scrape job Prometheus dans `docker-compose.prod.yml`
- [ ] Rule Cursor `observabilite.mdc` à créer (en parallèle, doc uniquement)
- [ ] Métriques d'impact instrumentées : coût Sentry mensuel, MTTD post-prod, MTTR P0/P1
- [ ] Mise à jour `CLAUDE.md` : ajouter section "Observabilité" + lien ADR-014/015/016/017
- [ ] Mise à jour `docs/prd/README.md` (index ADR)

---

## 6. Références

- PRD : `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.1
- Sentry Node SDK v8 : https://docs.sentry.io/platforms/javascript/guides/node/
- Sentry × OTel integration : https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/
- OpenTelemetry NestJS instrumentation : https://opentelemetry.io/docs/instrumentation/js/automatic/
- W3C Trace Context : https://www.w3.org/TR/trace-context/
- prom-client : https://github.com/siimon/prom-client
- ADRs liées : ADR-015 (BullMQ monitoring), ADR-016 (Logging), ADR-017 (Alerting)

---

*ADR-014 v1.0 — méthode [BMAD-light](../method/BMAD.md). À passer `Accepted` après sign-off CTO Design.*
