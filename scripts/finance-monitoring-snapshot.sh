#!/usr/bin/env bash
# =============================================================================
# scripts/finance-monitoring-snapshot.sh
#
# Helper SRE — Collecte les 9 indicateurs de surveillance 72h `FF=true`.
# Source de référence : docs/runbooks/finance-monitoring-72h-surveillance.md §2.
#
# Aucun side effect — read-only. Pas de modification cluster / DB.
# Sortie : stdout structuré pour copier-coller dans le checkpoint template.
#
# Usage :
#   ENV=rec ./scripts/finance-monitoring-snapshot.sh
#   ENV=prod ./scripts/finance-monitoring-snapshot.sh   (lecture seule également)
#
# Pré-requis :
#   - kubectl avec context configuré pour cleanconnect-<env>
#   - psql avec $DATABASE_URL pointant sur l'env
#   - redis-cli avec $REDIS_URL_HOST / port
#   - curl + $METRICS_TOKEN bearer pour /internal/metrics
#
# =============================================================================

set -euo pipefail

ENV="${ENV:-rec}"
NAMESPACE="cleanconnect-${ENV}"
API_HOST="${API_HOST:-${ENV}.cleanconnect.fr}"

# -----------------------------------------------------------------------------
# 0. Pré-vérifs CLI
# -----------------------------------------------------------------------------
for bin in kubectl psql redis-cli curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[FATAL] $bin requis (PATH)" >&2
    exit 2
  fi
done

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[FATAL] \$DATABASE_URL non défini" >&2
  exit 2
fi
if [ -z "${METRICS_TOKEN:-}" ]; then
  echo "[FATAL] \$METRICS_TOKEN non défini (Bearer /internal/metrics)" >&2
  exit 2
fi
if [ -z "${REDIS_HOST:-}" ]; then
  echo "[FATAL] \$REDIS_HOST non défini" >&2
  exit 2
fi

NOW_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOW_LOCAL=$(TZ=Europe/Paris date +"%Y-%m-%d %H:%M %Z")

# -----------------------------------------------------------------------------
# Header
# -----------------------------------------------------------------------------
cat <<EOF
=============================================================================
FINANCE MONITORING SNAPSHOT — $ENV
UTC   : $NOW_UTC
Paris : $NOW_LOCAL
=============================================================================

EOF

# -----------------------------------------------------------------------------
# 1. Cardinalité Prometheus
# -----------------------------------------------------------------------------
echo "--- [1/9] Cardinalité Prometheus 'cleanconnect_finance_*' ---"
CARD=$(curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "https://${API_HOST}/internal/metrics" 2>/dev/null \
  | grep -c "^cleanconnect_finance_" || true)
echo "  total séries : $CARD"
if [ "$CARD" -gt 150 ]; then echo "  STATUS : 🚨 ROLLBACK (>150)"
elif [ "$CARD" -gt 80 ]; then echo "  STATUS : ⚠️ ATTENTION (>80)"
else echo "  STATUS : ✅"
fi
echo

# -----------------------------------------------------------------------------
# 2. Alertes par kind sur 1h
# -----------------------------------------------------------------------------
echo "--- [2/9] Alertes /h par kind (1h glissant) ---"
psql "$DATABASE_URL" -At -F'|' <<'SQL'
SELECT kind, severity, COUNT(*) AS cnt
FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY kind, severity
ORDER BY cnt DESC;
SQL
echo

# -----------------------------------------------------------------------------
# 3. Retries Stripe (logs 1h)
# -----------------------------------------------------------------------------
echo "--- [3/9] Retries Stripe API sur 1h (logs cc-api) ---"
RETRIES=$(kubectl -n "$NAMESPACE" logs -l app=cc-api --since=1h 2>/dev/null \
  | grep -E 'finance\.(reconcile|stripe)\..*retry_failed' \
  | wc -l || echo 0)
echo "  count : $RETRIES"
if [ "$RETRIES" -gt 50 ]; then echo "  STATUS : 🚨 ROLLBACK"
elif [ "$RETRIES" -gt 10 ]; then echo "  STATUS : ⚠️ ATTENTION (vérifier statut Stripe)"
else echo "  STATUS : ✅"
fi
echo

# -----------------------------------------------------------------------------
# 4. Runs zombies
# -----------------------------------------------------------------------------
echo "--- [4/9] Runs zombies (RUNNING > 20 min) ---"
psql "$DATABASE_URL" -At -F'|' <<'SQL'
SELECT id, type, started_at, NOW() - started_at AS age
FROM finance_reconciliation_runs
WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes'
ORDER BY started_at;
SQL
echo

# -----------------------------------------------------------------------------
# 5. Sessions PG bloquées sur advisory lock finance
# -----------------------------------------------------------------------------
echo "--- [5/9] Sessions Postgres bloquées (advisory lock finance) ---"
psql "$DATABASE_URL" -At -F'|' <<'SQL'
SELECT pid, state, wait_event_type, wait_event, age(now(), state_change) AS waiting_for
FROM pg_stat_activity
WHERE state != 'idle'
  AND wait_event LIKE '%Lock%'
  AND query ILIKE '%pg_advisory_xact_lock%';
SQL
echo

# -----------------------------------------------------------------------------
# 6. Memory cc-api
# -----------------------------------------------------------------------------
echo "--- [6/9] Memory cc-api (kubectl top) ---"
kubectl -n "$NAMESPACE" top pods -l app=cc-api --no-headers 2>/dev/null || echo "  (metrics-server indisponible ?)"
echo

# -----------------------------------------------------------------------------
# 7. Redis memory
# -----------------------------------------------------------------------------
echo "--- [7/9] Redis used_memory ---"
redis-cli -h "$REDIS_HOST" INFO memory 2>/dev/null \
  | grep -E '^(used_memory_human|used_memory_peak_human|maxmemory_human|mem_fragmentation_ratio):'
echo

# -----------------------------------------------------------------------------
# 8. Schedulers derniers tirs
# -----------------------------------------------------------------------------
echo "--- [8/9] Schedulers — derniers tirs ---"
psql "$DATABASE_URL" -At -F'|' <<'SQL'
SELECT type, status, MAX(started_at) AS last_run, NOW() - MAX(started_at) AS age
FROM finance_reconciliation_runs
WHERE started_at > NOW() - INTERVAL '48 hours'
GROUP BY type, status
ORDER BY type, status;
SQL
echo

# -----------------------------------------------------------------------------
# 9. PII sample (3 vecteurs)
# -----------------------------------------------------------------------------
echo "--- [9/9] PII sample (logs 1h + metrics + alerts) ---"

LOG_PII=$(kubectl -n "$NAMESPACE" logs -l app=cc-api --since=1h 2>/dev/null \
  | grep -E '(@|sk_(test|live)_|whsec_|Bearer )' \
  | grep -vE '(\[REDACTED\]|authorization=\".*\")' \
  | wc -l || echo 0)
echo "  Logs PII match : $LOG_PII"

METRICS_PII=$(curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  "https://${API_HOST}/internal/metrics" 2>/dev/null \
  | grep -vE '_truncated' \
  | grep -E '(userId|missionId|paymentId|email|stripeId)=' \
  | wc -l || echo 0)
echo "  Metrics PII match : $METRICS_PII"

ALERT_PII=$(psql "$DATABASE_URL" -At <<'SQL'
SELECT COUNT(*) FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND (context::text ILIKE '%bearer %'
    OR context::text ILIKE '%sk_test_%'
    OR context::text ILIKE '%sk_live_%'
    OR context::text ~ '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}');
SQL
)
echo "  Alerts PII match : $ALERT_PII"

if [ "$LOG_PII" -gt 0 ] || [ "$METRICS_PII" -gt 0 ] || [ "$ALERT_PII" -gt 0 ]; then
  echo "  STATUS : 🚨 ROLLBACK IMMÉDIAT (fuite PII confirmée)"
else
  echo "  STATUS : ✅"
fi
echo

# -----------------------------------------------------------------------------
# Footer
# -----------------------------------------------------------------------------
cat <<EOF
=============================================================================
Snapshot terminé. Copier les blocs ci-dessus dans le checkpoint courant :
  docs/security-reviews/operational-72h-checkpoint-template.md
À noter le verdict global du checkpoint dans la section "Décision".
=============================================================================
EOF
