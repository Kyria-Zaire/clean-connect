# Clean Connect — Grafana provisioning (PRD-004 Build B)

Source de vérité : [`docs/adr/ADR-014-observability-architecture.md`](../../docs/adr/ADR-014-observability-architecture.md) + [`docs/prd/PRD-004-hardening-ops-compliance.md`](../../docs/prd/PRD-004-hardening-ops-compliance.md).

## Contenu

```
ops/grafana/
├── README.md                              ← vous êtes ici
├── provisioning/
│   ├── datasources/
│   │   └── prometheus.yml                 ← Prometheus scrape de l'API
│   └── dashboards/
│       └── dashboards.yml                 ← provider de dashboards JSON
└── dashboards/
    ├── api-health.json                    ← latence p50/p95/p99, RPS, errors
    ├── stripe-and-webhooks.json           ← Stripe API, webhooks, DLQ
    └── bullmq-and-queues.json             ← waiting/active/completed/failed
```

## Stack runtime

`docker-compose.observability.yml` (à la racine du repo) lance :

- **Prometheus** (`:9090`) — scrape `clean-connect-api:3000/api/internal/metrics`
- **Grafana** (`:3001`) — UI dashboards, datasource Prometheus auto-provisionnée
- **Tempo** (`:3200` optionnel) — collector OTLP/HTTP pour traces

```
docker-compose -f docker-compose.observability.yml up -d
```

## Sécurité (rappels CTO)

- L'endpoint `/api/internal/metrics` est protégé Bearer (cf. ADR-014 §2.4).
  Configurer `METRICS_BEARER_TOKEN` côté API + injecter le même token dans
  `prometheus.yml` (`authorization.credentials`).
- BullBoard est sur `/api/internal/queues` (JWT ADMIN + INTERNAL_BEARER_TOKEN).
  Aucune dépendance Prometheus / Grafana.
- Les dashboards ne sont pas exposés sur Internet — réseau intra-cluster
  uniquement (ou tunnel SSH / Tailscale).

## Maintenir un dashboard

1. Modifier le JSON dans `dashboards/<name>.json` (export Grafana → JSON model).
2. Reload Grafana : `docker compose restart grafana` (le provider charge à chaud
   en mode `updateIntervalSeconds: 30`).
3. Toute évolution de naming métrique → mettre à jour `metrics/<service>.ts`
   ET les requêtes PromQL des dashboards. Source de vérité = `metrics.service.ts`.

## Conventions PromQL utilisées

- `histogram_quantile(0.95, sum(rate(<metric>_bucket[5m])) by (le, route))`
- `rate(<counter>[1m])` pour les taux/s
- `sum by (queue, state) (cleanconnect_bullmq_jobs_total)`
- `increase(<counter>[5m])` pour les incréments cumulés sur fenêtre

## TODO(debt) — Build B+

- [ ] Alertmanager rules YAML (côté Prometheus) pour `metrics_endpoint_down`
      (Alerting Discord déjà couvre les 4 autres via cron checker → PRD-004 4.2).
- [ ] Tempo OTLP datasource Grafana + link traces ⇄ dashboards.
- [ ] Loki si on agrège les logs Pino dans le futur.
