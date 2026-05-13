# PRD-004 Ticket 4.5 — Finance monitoring Build itération 2 — readiness Verify / release

**PRD** : `docs/prd/PRD-004-hardening-ops-compliance.md` §4.15  
**Portée** : post–Build itération 2 (cœur métier reconcile + invariants + daily report + lifecycle ACK).

---

## 1. Smoke recette (après `pnpm db:migrate:deploy` + `FF_FINANCE_MONITORING_ENABLED=true`)

| # | Action | Attendu |
|---|--------|---------|
| S1 | `GET /v1/admin/finance/mismatches` (ADMIN JWT) | `200`, pagination `limit`/`cursor` |
| S2 | `GET /v1/admin/finance/mismatches?mismatchCode=FIN-I-003` | `200`, uniquement `mismatchCode=FIN-I-003` |
| S3 | `PATCH /v1/admin/finance/mismatches/:id` `{ "status": "ACKNOWLEDGED" }` | `200`, `acknowledgedAt` renseigné |
| S4 | `PATCH` `{ "status": "RESOLVED", "notes": "…≥16 chars…" }` | `200`, `resolvedAt` renseigné |
| S5 | `POST /v1/admin/finance/runs/manual` (2× < 1 h) | 2e appel `429` si rate-limit ; sinon `202` + `runId` |
| S6 | Cron reconcile (ou manual) avec 1 drift `Transfer.amount` ≠ `providerPayout` | `FinanceMismatch` `FIN-I-003` créé, alerte `finance_mismatch` (cooldown respecté) |
| S7 | `GET /v1/admin/finance/daily-report/YYYY-MM-DD` (date J-1 Paris) | `200` ou `404` si pas encore généré |

---

## 2. Perf gates (MVP)

- **Reconcile** : borne `RECONCILE_BATCH_SIZE = 600` payments / run — surveiller `durationMs` (`finance_reconciliation_duration_seconds`) ; si > 10 min récurrent → ticket pagination cursor.
- **Stripe** : 25 req/s token bucket + timeout 10 s — pas de retry infini (fail → log warn, invariant Stripe skipped).
- **Stuck** : batch 1000 payments + 1000 transfers — ajuster si table growth.

---

## 3. Release checklist (CTO)

- [ ] Migration `20260513030000` appliquée **tous** envs (dev → rec → preprod → prod).
- [ ] `FF_FINANCE_MONITORING_ENABLED` : `true` recette **après** validation smoke S1–S7.
- [ ] Grafana : dashboards `cleanconnect_finance_*` + alertes routing (Discord/Resend quand PR #20).
- [ ] Runbook : [`finance-reconciliation-runbook.md`](./finance-reconciliation-runbook.md) — section **Dépendances critiques** relue (Stripe, Redis, DB, Prometheus, email).
- [ ] Aucune clé `sk_live_*` sur DB test ; webhooks isolés par env.

---

## 4. DPO — rétention (OQ-12)

- `FinanceMismatch` : purge **90 j** pour tous statuts (`OPEN`, `ACKNOWLEDGED`, `INVESTIGATING`, `RESOLVED`, `IGNORED`) — implémenté `purgeMismatchesPastRetention` (détecté `detectedAt` ou `resolvedAt` selon statut).
- `FinanceDailyReport` : **5 ans** (inchangé).
- **Validation DPO** : confirmer alignement registre traitements / durées affichées admin.

---

## 5. Trous Verify connus (à traiter itération 3 ou ticket)

- Webhook consistency / duplicate Stripe events : pas de test dédié (nécessite fixture `StripeWebhookEvent` + scénario replay).
- `MISSING_DB` / imports Stripe dashboard : pas d’invariant dédié (TODO ADR).
- Perf sous charge : pas de test charge automatisé.
