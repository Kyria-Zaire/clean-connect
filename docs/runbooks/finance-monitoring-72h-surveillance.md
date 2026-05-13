# Surveillance 72 h — `FF_FINANCE_MONITORING_ENABLED=true` en recette

> **Cible** : SRE on-call recette pendant la fenêtre de validation 72 h post-activation.
> **Doc parent** : [`finance-monitoring-activation.md`](finance-monitoring-activation.md)
> **Décision Go/No-Go prod** : [`finance-monitoring-go-no-go-prod.md`](finance-monitoring-go-no-go-prod.md)

## Philosophie

> **72 h sans surprise = base éligible Go prod.** Une seule alerte P0 ou un seul drift technique inattendu = retour engineering. **On ne corrige pas une dérive en recette en live** — on rollback `FF=false`, on investigue à froid, on relance.

---

## 1. Cadence de surveillance

| Fenêtre | Cadence checks | Responsable |
|---|---|---|
| T0 → T+4h | check toutes les **30 min** | SRE primaire (synchrone) |
| T+4h → T+24h | check toutes les **2 h** + revue logs / dashboards | SRE on-call |
| T+24h → T+72h | check **2×/jour** (matin + après-midi) | SRE on-call |
| Daily report 07:00 EU/Paris | **vérification dédiée** chaque jour J+1, J+2, J+3 | SRE on-call |

À chaque check, **noter** dans le rapport `operational-smoke-rec-2026-05-13.md` toute valeur anormale, même sans seuil franchi.

---

## 2. Indicateurs à surveiller

### 2.1 Cardinalité Prometheus (anti-explosion labels)

```bash
# Cible : ≤ 80 séries `cleanconnect_finance_*`
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  https://rec.cleanconnect.fr/internal/metrics \
  | grep -c "^cleanconnect_finance_"
```

| Seuil | Action |
|---|---|
| ≤ 80 | ✅ nominal |
| 80-150 | ⚠️ investiguer : nouveaux types/severities apparus ? |
| > 150 | 🚨 **rollback immédiat** — fuite cardinalité (whitelist contournée ?) |

### 2.2 Alert fatigue Discord `#ops-finance`

```sql
SELECT kind, severity, COUNT(*) AS cnt
FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY kind, severity
ORDER BY cnt DESC;
```

| Seuil | Action |
|---|---|
| < 5 alertes/h par `kind` | ✅ nominal |
| 5-20 alertes/h sur un `kind` | ⚠️ vérifier que cooldown s'applique ; ouvrir incident niveau 2 |
| > 20 alertes/h sur un `kind` | 🚨 **rollback immédiat** — boucle / cooldown brisé |

### 2.3 Retry storms

```bash
# Si OTel ou logs structurés actifs
kubectl -n cleanconnect-rec logs -l app=cc-api --since=1h \
  | grep -E 'finance\.(reconcile|stripe)\..*retry_failed' \
  | wc -l
```

| Seuil | Action |
|---|---|
| < 10/h | ✅ |
| 10-50/h | ⚠️ probable incident Stripe API — vérifier `status.stripe.com` |
| > 50/h | 🚨 **rollback** + ticket incident SRE |

### 2.4 Stuck jobs / locks

```sql
-- 2.4a : runs zombies
SELECT id, type, started_at, NOW() - started_at AS age
FROM finance_reconciliation_runs
WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes';

-- 2.4b : sessions Postgres bloquées sur advisory lock finance
SELECT pid, state, wait_event_type, wait_event, age(now(), state_change) AS waiting_for, query
FROM pg_stat_activity
WHERE state != 'idle' AND wait_event LIKE '%Lock%' AND query LIKE '%pg_advisory_xact_lock%';
```

| Seuil | Action |
|---|---|
| 0 zombie, 0 session bloquée | ✅ |
| 1-2 zombies après pre-tick cleanup | ⚠️ acceptable, log `markStaleRunningRunsFailed` |
| > 2 sessions bloquées > 30 s | 🚨 **rollback** + investigation contention |

### 2.5 Discord spam (alert fatigue côté humain)

- Compter le nombre de messages dans `#ops-finance` sur 1 h
- Cible : < 10/h pour pouvoir lire chaque alerte
- > 20/h sur 2 h consécutives → ⚠️ ajuster cooldowns

### 2.6 Memory growth `cc-api` (recette)

```bash
kubectl -n cleanconnect-rec top pods -l app=cc-api
```

| Évolution sur 24h | Action |
|---|---|
| Stable (< +10 %) | ✅ |
| +10 % → +50 % | ⚠️ probable leak `cooldownMap` (Map JS non purgé) — observer |
| > +50 % | 🚨 **rollback** + heap dump avant restart |

> **Note** : `FinanceAlertingService.cooldownMap` est un `Map<string, number>` jamais purgé en mémoire. À T+72h on a au pire ~50 entrées (10 kinds × 5 scopes typiques) — taille négligeable. Si croissance plus rapide → investigation.

### 2.7 Redis growth

```bash
redis-cli -h $REC_REDIS_HOST INFO memory | grep used_memory_human
```

| Évolution | Action |
|---|---|
| Stable | ✅ |
| +50 MB sur 24 h | ⚠️ vérifier que `finance.*` n'écrit pas en Redis (ne devrait **rien** écrire — locks sont en DB Postgres) |
| Spike soudain | 🚨 investigation |

### 2.8 Queue backlog (BullMQ)

```bash
# Via BullBoard ou redis-cli :
redis-cli LLEN bull:stripe-webhooks:wait
redis-cli LLEN bull:escrow-auto-release:wait
```

Les schedulers finance ne consomment **pas** de queue BullMQ — donc aucun impact attendu sur ces backlog. Si backlog grimpe : c'est indépendant du FF, vérifier PRD-003.

### 2.9 Scheduler drift

```sql
-- Vérifie que chaque cron a tiré au moins une fois dans sa fenêtre attendue
SELECT type, MAX(started_at) AS last_run, NOW() - MAX(started_at) AS age
FROM finance_reconciliation_runs
GROUP BY type
ORDER BY type;
```

| Drift observé | Action |
|---|---|
| `reconcile` last_run > 25 h | ⚠️ cron a sauté → vérifier `@Cron` actif côté pod élu (Bull/master) |
| `daily-report` last_run > 25 h | ⚠️ idem |
| `retention` last_run > 25 h | ⚠️ idem |
| `stuck-funds` last_run > 90 min | 🚨 horaire → si > 90 min, cron skippé 2 fois |

---

## 3. Tableau de bord rapide (à imprimer / Notion)

| Indicateur | Cible | Mesure T+1h | T+24h | T+48h | T+72h |
|---|---|---|---|---|---|
| Cardinalité Prom | ≤ 80 | _ | _ | _ | _ |
| Alertes/h par kind | < 5 | _ | _ | _ | _ |
| Retries Stripe/h | < 10 | _ | _ | _ | _ |
| Runs zombies | 0 | _ | _ | _ | _ |
| Sessions PG bloquées | 0 | _ | _ | _ | _ |
| Messages Discord/h | < 10 | _ | _ | _ | _ |
| `cc-api` mem | stable | _ | _ | _ | _ |
| Daily report J-1 envoyé | ✅ | n/a | _ | _ | _ |
| Open mismatches P1/P2 | stable | _ | _ | _ | _ |

---

## 4. Quand déclencher rollback (rappel runbook §4)

**Déclencheurs absolus** (n'importe lequel suffit) :

1. 1 alerte **P0** finance (impact paiement client direct)
2. ≥ 3 alertes **P1** finance en < 30 min, hors anomaly détectée par le système lui-même
3. Cardinalité Prometheus > 150 séries
4. `cleanconnect_finance_reconciliation_runs_total{status="FAILED"}` > 5 en 1 h
5. Memory growth > +50 % sur 24 h
6. > 2 sessions Postgres bloquées sur advisory lock > 30 s
7. Latence p99 API globale > 2 s (même indirectement)
8. **Tout doute SRE** — on rollback, on investigue à froid

**Procédure** : runbook §4.1 → §4.2 → §4.3 (cleanup zombies si besoin) → §4.4 (post-mortem).

---

## 5. Critères Go (basés sur 72 h)

À T+72h, **TOUS** les indicateurs ci-dessous doivent être verts pour **éligibilité** au Go prod (la décision finale reste DPO + CTO, cf. `finance-monitoring-go-no-go-prod.md`) :

| Critère | Cible 72 h |
|---|---|
| **Stabilité** | 0 rollback, 0 P0, ≤ 1 P1 expliqué |
| **Cardinalité** | ≤ 80 séries Prom finance sur toute la fenêtre |
| **Schedulers** | 6/6 ont tiré au moins 1× dans leur fenêtre attendue |
| **Daily reports** | 3/3 envoyés (J-1, J-2, J-3 si applicable) avec email reçu et `balanceHealthy=true` |
| **PII** | 3/3 vecteurs (logs, metrics, emails) sans fuite confirmée |
| **Rollback testé** | E1-E6 du smoke ✅ |
| **Invariants finance** | 0 double payout, 0 double refund, 0 mutation Stripe initiée (cf. requêtes §2.4 / §3 du smoke) |
| **Rapport opérationnel signé** | SRE primaire + secondaire + reviewer sécu |

---

## 6. Communication 72 h

| Cadence | Audience | Format |
|---|---|---|
| T0, T+1h, T+4h | Slack `#engineering` | « ✅ FF=true recette, smoke en cours, prochain check `<heure>` » |
| Quotidien J+1, J+2, J+3 | Slack `#engineering` + CTO | « FF=true recette J+N : 0/1/2 incidents. Indicateurs : cardinalité=…, alertes=…, runs=… » |
| Toute alerte P0/P1 inattendue | `#ops-critical` immédiat | rollback ou triage runbook |
| T+72h | CTO + DPO | livraison du rapport `operational-smoke-rec-2026-05-13.md` complété pour décision Go/No-Go prod |

---

*Document produit le 2026-05-13. À actualiser après chaque itération.*
