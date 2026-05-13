# Runbook — Activation `FF_FINANCE_MONITORING_ENABLED` (recette → prod)

> **Cible** : SRE on-call, ops finance, CTO.
> **Pré-requis** : PR `feat/fin-iter2-debts` mergée, rapport Verify final READY (`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`).
> **Doc complémentaire** : `docs/ops/finance-reconciliation-runbook.md` (lecture mismatches, alertes Discord) et `docs/ops/finance-iteration-2-verify-readiness.md` (smoke historique Design).

## Règle d'or

> **Le flag se descend en quelques secondes. On ne fait jamais un débogage ou un fix sous FF=true en prod.** Si quoi que ce soit dévie de la procédure ci-dessous → **FF=false immédiat** (cf. §4 Rollback) et investigation à froid.

---

## 1. Pré-vérifications (T-1 j)

À faire **avant** de planifier l'activation, par le SRE responsable.

| Check | Commande / endroit | Attendu |
|---|---|---|
| Branche mergée | `git log --oneline main \| head -5` | commit de merge PR #29 visible |
| Migration DB appliquée | `pnpm --filter @cc/api exec prisma migrate status` | `Database schema is up to date!` |
| Secrets Resend provisionnés (recette/prod) | secrets manager | `RESEND_API_KEY`, `FINANCE_DAILY_REPORT_EMAIL_TO`, `RESEND_FROM_EMAIL` présents |
| `STRIPE_API_VERSION` aligné dashboard | `.env.<env>` + dashboard Stripe | identique sur les **2** endpoints (test/live) |
| Prometheus scrape healthy | Grafana → Explore | `up{job="cc-api"} == 1` sur l'env cible |
| Discord webhook actif | message test sur `#ops-finance` | message reçu |
| Capacité on-call déclarée | calendrier d'astreinte | SRE primaire + secondaire identifiés |
| Plan de communication équipe | Slack `#engineering` | annonce 1 h avant T0 |

> Si **un** check ❌ : **on n'active pas**.

---

## 2. Activation FF=true en RECETTE (smoke réel)

### 2.1 T0 — Activation

```bash
# 1. Mettre à jour le secret env recette
#    via secrets manager (Doppler / Vault / GH env secrets) :
FF_FINANCE_MONITORING_ENABLED=true

# 2. Rolling restart des pods/containers apps/api en recette
#    (laisser HPA gérer ; au moins 1 instance reste healthy)
kubectl -n cleanconnect-rec rollout restart deploy/cc-api
kubectl -n cleanconnect-rec rollout status  deploy/cc-api --timeout=120s

# 3. Vérification boot
curl -fsS https://rec.cleanconnect.fr/healthz
curl -fsS https://rec.cleanconnect.fr/readyz
```

**Attendu** : 2 × HTTP 200, `status:"ok"`. Tous les pods passent `Ready` dans les 90 s.

### 2.2 T+5 min — Schedulers actifs

```bash
# Logs Pino — la ligne "finance.<scheduler>.disabled" doit AVOIR DISPARU
# (elle apparaissait toutes les minutes sous FF=false)
kubectl -n cleanconnect-rec logs -l app=cc-api --since=5m \
  | grep -E 'finance\.(reconcile|stuck|invariants|payout|daily_report|retention)\.disabled'
```

**Attendu** : aucun match (les schedulers tournent).

### 2.3 T+10 min — Manual run reconcile

Test fonctionnel rapide depuis le poste admin :

```bash
TOKEN=$(./scripts/forge-admin-jwt-rec.sh)
curl -fsS -X POST https://rec.cleanconnect.fr/v1/admin/finance/runs/manual \
  -H "Authorization: Bearer $TOKEN"
# → 202 ACCEPTED { runId: "..." }

# 2ème appel < 1h plus tard
curl -fsS -X POST https://rec.cleanconnect.fr/v1/admin/finance/runs/manual \
  -H "Authorization: Bearer $TOKEN"
# → 429 FINANCE_MANUAL_RUN_RATE_LIMIT
```

**Attendu** : `202` puis `429` (OQ-13 atomique vérifié en réel).

### 2.4 T+10 min — Suite smoke complète

Exécuter intégralement la **checklist §6 du rapport Verify final** (10 sections : activation, schedulers, endpoints admin, webhooks, email, métriques, dashboards, BullBoard, alerting Discord, absence PII). Cocher au fur et à mesure dans le **template rapport** `docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md` (à dupliquer en `operational-smoke-rec-YYYY-MM-DD.md`).

### 2.5 T+24 h — Daily report

Le **lendemain 07:05 Europe/Paris**, vérifier :

```bash
# 1. Email reçu sur l'inbox ops
# 2. Row DB
psql "$REC_DATABASE_URL" -c "
  SELECT report_date, balance_cents, captured_cents, transfer_sent_cents,
         refunded_cents, open_mismatch_count
  FROM finance_daily_reports
  ORDER BY report_date DESC LIMIT 3;
"

# 3. Pas d'alerte finance_daily_report_failed
psql "$REC_DATABASE_URL" -c "
  SELECT id, kind, severity, created_at, context
  FROM finance_alerts
  WHERE kind = 'finance_daily_report_failed' AND created_at > NOW() - INTERVAL '24 hours';
"
```

**Attendu** : email présent, row J-1 créé, **0 alerte daily_report_failed**.

### 2.6 T+72 h — Stabilité

- Aucune alerte P0/P1 inattendue (`#ops-critical`, `#ops-finance`)
- `cleanconnect_finance_reconciliation_runs_total{status="FAILED"}` reste bas
- `pg_stat_activity` : pas de session bloquée sur `pg_advisory_xact_lock`
- Cardinalité Prometheus : `curl -fsS https://rec.cleanconnect.fr/internal/metrics -H "Authorization: Bearer $METRICS_TOKEN" | grep "^cleanconnect_finance_" | wc -l` ≤ 80

---

## 3. Activation FF=true en PRODUCTION

> **Pré-requis** : recette ≥ 72 h stable, rapport `operational-smoke-rec-*.md` signé SRE, **DPO sign-off**, **CTO sign-off**.

Mêmes étapes que §2 mais sur l'env `prod` :

```bash
# Secret manager prod
FF_FINANCE_MONITORING_ENABLED=true

kubectl -n cleanconnect-prod rollout restart deploy/cc-api
kubectl -n cleanconnect-prod rollout status  deploy/cc-api --timeout=120s
```

**Différences prod** :

1. **Fenêtre d'activation** : créneau **mardi/mercredi 10h-12h Europe/Paris** (jamais vendredi, jamais hors heures ouvrées).
2. **2 SRE on-call** présents en synchrone pendant les 30 premières minutes.
3. **CTO joignable** sur les 4 premières heures (rollback decision).
4. **Dashboard Grafana** ouvert en permanence sur `Finance — Reconciliation overview`.
5. **PagerDuty / Opsgenie** : route P0/P1 finance → astreinte primaire.
6. **Pas de manual run admin** pendant les 24 premières heures (on laisse le cron 03:30 EU/Paris tourner).
7. **Smoke prod réduite** : §2.1 → §2.2 → §2.5 (skip §2.3 manual run + §2.4 smoke complet — déjà validés en recette).

---

## 4. Rollback immédiat (FF=false)

> **Déclencheurs** :
>
> - 1 alerte P0 finance (impact paiement client)
> - ≥ 3 alertes P1 finance en < 30 min
> - `cleanconnect_finance_reconciliation_runs_total{status="FAILED"}` > 5 en 1 h
> - Cardinalité Prometheus > 200 séries finance (dérive label inattendue)
> - Latence p99 API > 2 s (impact général)
> - Tout doute SRE → on rollback, on investigue à froid

### 4.1 Procédure

```bash
# 1. Désactivation flag (secret manager)
FF_FINANCE_MONITORING_ENABLED=false

# 2. Rolling restart (15-30 s)
kubectl -n cleanconnect-<env> rollout restart deploy/cc-api
kubectl -n cleanconnect-<env> rollout status  deploy/cc-api --timeout=120s

# 3. Vérifier arrêt des schedulers
kubectl -n cleanconnect-<env> logs -l app=cc-api --since=2m \
  | grep -E 'finance\.(reconcile|stuck|invariants|payout|daily_report|retention)\.disabled' \
  | head
# → 6 lignes attendues (une par scheduler) au prochain tick
```

### 4.2 Vérifications post-rollback

| Check | Attendu |
|---|---|
| `/healthz` + `/readyz` | 200 / OK |
| Logs `finance.<scheduler>.disabled` réapparaissent au prochain tick | ✅ |
| `FinanceReconciliationRun` `RUNNING` existants | marqués `FAILED` par `markAllStaleRunningRunsFailed` au prochain tick d'un scheduler — ou via SQL manuel ci-dessous |
| Alertes Discord cessent d'être émises | ✅ (au prochain cycle cooldown) |
| BullMQ workers `stripe-webhooks` / `escrow-auto-release` | **non impactés** (totalement indépendants du FF) |

### 4.3 Nettoyage runs zombies (si besoin)

Si un run reste `RUNNING` après rollback (worker tué) :

```sql
-- À exécuter UNIQUEMENT après rollback FF=false confirmé
UPDATE finance_reconciliation_runs
SET status = 'FAILED',
    completed_at = NOW(),
    failure_message = 'rollback_cleanup'
WHERE status = 'RUNNING'
  AND started_at < NOW() - INTERVAL '30 minutes';
```

> ⚠️ **À justifier par un ticket d'incident**. Idéalement attendre le prochain tick d'un scheduler qui appellera `markAllStaleRunningRunsFailed` automatiquement (max 30 min).

### 4.4 Post-mortem

- Ouvrir un incident `OPS-FINANCE-<date>` dans le tracker
- Joindre : logs 30 min avant/après, screenshots dashboards, dump `finance_alerts` + `finance_reconciliation_runs` filtré sur la fenêtre
- Décider next steps : fix code → patch → re-Verify → re-activation OU `FF=false` durable

---

## 5. Communication

| Audience | Channel | Message type |
|---|---|---|
| Équipe engineering | Slack `#engineering` | T-1 h annonce + T0 activation + T+24 h status |
| Ops finance | Slack `#ops-finance` | T0 activation, alertes Discord à monitorer |
| CTO / DPO | direct | sign-off requis avant activation prod, status quotidien J+1..J+3 |
| Astreinte | PagerDuty / Opsgenie | route P0/P1 finance armée |

**Formulation autorisée** (PRD §4.15.17 — CTO 2026-05-13) :

> « Les schedulers de monitoring financier sont activés en `<recette|production>` à `<HH:MM Europe/Paris>`. FF off-switch reste disponible 24/7. »

**Formulation interdite** :

> ~~« Le monitoring financier est en place / opérationnel / complet. »~~ (tant que toutes les itérations PRD-004 ne sont pas closes)

---

## 6. Référence — endpoints & commandes utiles

| Action | Commande |
|---|---|
| Lister mismatches | `GET /v1/admin/finance/mismatches?status=OPEN` |
| Détail mismatch | `GET /v1/admin/finance/mismatches/:id` |
| Acknowledger mismatch | `PATCH /v1/admin/finance/mismatches/:id` body `{ status:'ACKNOWLEDGED' }` |
| Manual run reconcile | `POST /v1/admin/finance/runs/manual` (rate-limit OQ-13) |
| Lire daily report | `GET /v1/admin/finance/daily-report/2026-05-12` |
| Replay webhook DLQ | `POST /v1/admin/webhooks/stripe-dead-letters/:id/replay` |
| Metrics scrape | `GET /internal/metrics` (Bearer) |

| Doc | Lien |
|---|---|
| Rapport Verify final | `docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md` |
| Runbook reconciliation | `docs/ops/finance-reconciliation-runbook.md` |
| Smoke recette précédent (Design) | `docs/ops/finance-iteration-2-verify-readiness.md` |
| ADR-018 (monitoring finance) | `docs/adr/ADR-018-*.md` |
| PRD-004 §4.15 | `docs/prd/PRD-004-hardening-ops-compliance.md` |

---

*Runbook produit le 2026-05-13. À actualiser après chaque itération PRD-004 majeure.*
