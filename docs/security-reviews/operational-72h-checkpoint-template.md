# Checkpoint observation 72 h — `FF=true` recette

> **Usage** : dupliquer ce template à chaque checkpoint (T+15min, T+1h, T+4h, T+12h, T+24h, T+48h, T+72h).
> **Nom final** : `operational-72h-checkpoint-T+<XX>-rec-YYYY-MM-DD.md` (ex. `operational-72h-checkpoint-T+1h-rec-2026-05-13.md`).
> **À compléter par** : SRE on-call au moment du checkpoint.
> **Temps cible** : 5-10 min par checkpoint (10-15 min pour T+72h).
> **Helper script** : `scripts/finance-monitoring-snapshot.sh` (ou `.ps1`) — pré-collecte automatique des indicateurs (cf. [`docs/runbooks/finance-monitoring-72h-surveillance.md`](../runbooks/finance-monitoring-72h-surveillance.md)).

---

## Méta

| Champ | Valeur |
|---|---|
| Checkpoint | _T+15min / T+1h / T+4h / T+12h / T+24h / T+48h / T+72h_ |
| Horodatage UTC | _YYYY-MM-DDTHH:MM:00Z_ |
| Horodatage Europe/Paris | _YYYY-MM-DD HH:MM_ |
| SRE on-call | _@…_ |
| Verdict checkpoint | ⏳ EN COURS / ✅ NOMINAL / ⚠️ ATTENTION / 🚨 ROLLBACK |

---

## Indicateurs (cf. surveillance §2)

| Indicateur | Cible | Mesure | Status |
|---|---|---|---|
| Cardinalité Prom `cleanconnect_finance_*` | ≤ 80 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Alertes/h max sur un `kind` | < 5 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Retries Stripe/h | < 10 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Runs zombies (`RUNNING > 20min`) | 0 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Sessions PG bloquées advisory lock | 0 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Messages Discord/h `#ops-finance` | < 10 | _ | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| `cc-api` mem évolution | stable | _ Mi (Δ vs T0 : _ %) | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Redis `used_memory_human` | stable | _ (Δ : _) | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |
| Latence p99 API globale | < 500 ms | _ ms | ☐ ✅ / ☐ ⚠️ / ☐ 🚨 |

### Commandes rapides (à coller dans le terminal)

```bash
# Cardinalité Prom
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  https://rec.cleanconnect.fr/internal/metrics \
  | grep -c "^cleanconnect_finance_"

# Alertes 1h
psql "$REC_DATABASE_URL" -c "
  SELECT kind, severity, COUNT(*) AS cnt
  FROM finance_alerts WHERE created_at > NOW() - INTERVAL '1 hour'
  GROUP BY kind, severity ORDER BY cnt DESC;
"

# Runs zombies
psql "$REC_DATABASE_URL" -c "
  SELECT id, type, started_at, NOW() - started_at AS age
  FROM finance_reconciliation_runs
  WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes';
"

# Sessions PG advisory lock bloquées
psql "$REC_DATABASE_URL" -c "
  SELECT pid, state, wait_event, age(now(), state_change) AS waiting_for
  FROM pg_stat_activity
  WHERE state != 'idle' AND wait_event LIKE '%Lock%' AND query LIKE '%pg_advisory_xact_lock%';
"

# cc-api memory
kubectl -n cleanconnect-rec top pods -l app=cc-api

# Redis memory
redis-cli -h $REC_REDIS_HOST INFO memory | grep used_memory_human
```

---

## Schedulers — derniers tirs

```sql
SELECT type, status, MAX(started_at) AS last_run, NOW() - MAX(started_at) AS age
FROM finance_reconciliation_runs
GROUP BY type, status
ORDER BY type;
```

| `type` | dernier `started_at` | `age` | status | Note |
|---|---|---|---|---|
| RECONCILE | _ | _ | _ | _ |
| STUCK | _ | _ | _ | _ |
| INVARIANTS | _ | _ | _ | _ |
| PAYOUT_ANOMALY | _ | _ | _ | _ |
| REPORT | _ | _ | _ | _ |

---

## Mismatches émergents (depuis dernier checkpoint)

```sql
SELECT mismatch_code, severity, status, COUNT(*)
FROM finance_mismatches
WHERE detected_at > '<heure dernier checkpoint>'
GROUP BY mismatch_code, severity, status
ORDER BY mismatch_code;
```

| `mismatch_code` | Severity | Total | Status |
|---|---|---|---|
| _ | _ | _ | _ |

---

## Sécurité — sample PII

À chaque checkpoint, faire **1 grep rapide** sur chaque vecteur :

| Vecteur | Commande | Match ? |
|---|---|---|
| Logs `cc-api` (dernière heure) | `kubectl logs --since=1h \| grep -E '(@\|sk_(test\|live)_\|whsec_\|Bearer )'` | ☐ 0 / ☐ ≥ 1 |
| Metrics PII | `curl /internal/metrics \| grep -E '(userId\|missionId\|paymentId\|email)='` | ☐ 0 / ☐ ≥ 1 |
| `finance_alerts.context` | requête C4 du final report | ☐ 0 / ☐ ≥ 1 |

> Tout match ≥ 1 → **rollback immédiat** (cf. playbook P0).

---

## Incidents détectés ce checkpoint

| ID | Horodatage | Sévérité | Description | Action immédiate |
|---|---|---|---|---|
| _INC-XXX_ | _ | _ | _ | _ |

---

## Commentaire libre

> Tout ce qui mérite attention sans relever d'un incident chiffré : ressenti, comportement bizarre, latence, message Discord ambigu, etc.

_Texte libre._

---

## Décision à ce checkpoint

- [ ] ✅ **Continuer observation** — tous indicateurs verts, aucun incident
- [ ] ⚠️ **Continuer en vigilance** — 1 ou 2 indicateurs en ⚠️ (jaune), pas de seuil critique franchi, surveiller intensivement le prochain checkpoint
- [ ] 🚨 **Rollback déclenché** — détailler ci-dessous

### Si rollback (🚨)

| Champ | Valeur |
|---|---|
| Heure de décision | _ |
| Heure de désactivation FF=false | _ |
| Heure de retour stable | _ |
| Durée totale | _ min |
| Incident lié | INC-XXX |
| Cause racine présumée | _ |

> Compléter ensuite la section §8 du final report et un post-mortem dédié.

---

*Checkpoint clôturé à _HH:MM_ Europe/Paris. Prochain checkpoint : _T+<XX>_.*
