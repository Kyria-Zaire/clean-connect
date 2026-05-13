# =============================================================================
# scripts/finance-monitoring-snapshot.ps1
#
# Helper SRE (Windows / PowerShell) — Collecte des 9 indicateurs de surveillance.
# Équivalent PowerShell de finance-monitoring-snapshot.sh.
# Source de référence : docs/runbooks/finance-monitoring-72h-surveillance.md §2.
#
# Aucun side effect — read-only.
#
# Usage :
#   $env:ENV = "rec"
#   $env:METRICS_TOKEN = "..."
#   $env:DATABASE_URL = "..."
#   $env:REDIS_HOST = "..."
#   .\scripts\finance-monitoring-snapshot.ps1
#
# Pré-requis :
#   - kubectl, psql, redis-cli, curl dans le PATH
# =============================================================================

$ErrorActionPreference = "Stop"

$Env = $env:ENV
if (-not $Env) { $Env = "rec" }
$Namespace = "cleanconnect-$Env"
$ApiHost = $env:API_HOST
if (-not $ApiHost) { $ApiHost = "$Env.cleanconnect.fr" }

foreach ($bin in @("kubectl","psql","redis-cli","curl.exe")) {
  if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
    Write-Error "[FATAL] $bin requis dans le PATH"
    exit 2
  }
}

if (-not $env:DATABASE_URL) { Write-Error "[FATAL] \$DATABASE_URL non défini"; exit 2 }
if (-not $env:METRICS_TOKEN) { Write-Error "[FATAL] \$METRICS_TOKEN non défini"; exit 2 }
if (-not $env:REDIS_HOST) { Write-Error "[FATAL] \$REDIS_HOST non défini"; exit 2 }

$NowUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$NowLocal = (Get-Date).ToString("yyyy-MM-dd HH:mm zzz")

@"
=============================================================================
FINANCE MONITORING SNAPSHOT — $Env
UTC   : $NowUtc
Local : $NowLocal
=============================================================================
"@ | Write-Output
Write-Output ""

# -----------------------------------------------------------------------------
# 1. Cardinalité Prom
# -----------------------------------------------------------------------------
Write-Output "--- [1/9] Cardinalité Prometheus 'cleanconnect_finance_*' ---"
$metrics = curl.exe -fsS -H "Authorization: Bearer $env:METRICS_TOKEN" "https://$ApiHost/internal/metrics" 2>$null
$card = ($metrics -split "`n" | Select-String -Pattern "^cleanconnect_finance_" | Measure-Object).Count
Write-Output "  total séries : $card"
if ($card -gt 150) { Write-Output "  STATUS : 🚨 ROLLBACK (>150)" }
elseif ($card -gt 80) { Write-Output "  STATUS : ⚠️ ATTENTION (>80)" }
else { Write-Output "  STATUS : ✅" }
Write-Output ""

# -----------------------------------------------------------------------------
# 2. Alertes / kind / 1h
# -----------------------------------------------------------------------------
Write-Output "--- [2/9] Alertes /h par kind (1h glissant) ---"
$q2 = @"
SELECT kind, severity, COUNT(*) AS cnt
FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY kind, severity
ORDER BY cnt DESC;
"@
psql $env:DATABASE_URL -At -F'|' -c $q2
Write-Output ""

# -----------------------------------------------------------------------------
# 3. Retries Stripe
# -----------------------------------------------------------------------------
Write-Output "--- [3/9] Retries Stripe API sur 1h ---"
$logs = kubectl -n $Namespace logs -l app=cc-api --since=1h 2>$null
$retries = ($logs -split "`n" | Select-String -Pattern "finance\.(reconcile|stripe)\..*retry_failed" | Measure-Object).Count
Write-Output "  count : $retries"
if ($retries -gt 50) { Write-Output "  STATUS : 🚨 ROLLBACK" }
elseif ($retries -gt 10) { Write-Output "  STATUS : ⚠️ ATTENTION (vérifier statut Stripe)" }
else { Write-Output "  STATUS : ✅" }
Write-Output ""

# -----------------------------------------------------------------------------
# 4. Runs zombies
# -----------------------------------------------------------------------------
Write-Output "--- [4/9] Runs zombies (RUNNING > 20 min) ---"
$q4 = @"
SELECT id, type, started_at, NOW() - started_at AS age
FROM finance_reconciliation_runs
WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes'
ORDER BY started_at;
"@
psql $env:DATABASE_URL -At -F'|' -c $q4
Write-Output ""

# -----------------------------------------------------------------------------
# 5. Sessions PG bloquées
# -----------------------------------------------------------------------------
Write-Output "--- [5/9] Sessions PG bloquées (advisory lock) ---"
$q5 = @"
SELECT pid, state, wait_event_type, wait_event, age(now(), state_change) AS waiting_for
FROM pg_stat_activity
WHERE state != 'idle'
  AND wait_event LIKE '%Lock%'
  AND query ILIKE '%pg_advisory_xact_lock%';
"@
psql $env:DATABASE_URL -At -F'|' -c $q5
Write-Output ""

# -----------------------------------------------------------------------------
# 6. Memory cc-api
# -----------------------------------------------------------------------------
Write-Output "--- [6/9] Memory cc-api (kubectl top) ---"
kubectl -n $Namespace top pods -l app=cc-api --no-headers 2>$null
Write-Output ""

# -----------------------------------------------------------------------------
# 7. Redis
# -----------------------------------------------------------------------------
Write-Output "--- [7/9] Redis used_memory ---"
redis-cli -h $env:REDIS_HOST INFO memory 2>$null | Select-String -Pattern "^(used_memory_human|used_memory_peak_human|maxmemory_human|mem_fragmentation_ratio):"
Write-Output ""

# -----------------------------------------------------------------------------
# 8. Schedulers
# -----------------------------------------------------------------------------
Write-Output "--- [8/9] Schedulers — derniers tirs ---"
$q8 = @"
SELECT type, status, MAX(started_at) AS last_run, NOW() - MAX(started_at) AS age
FROM finance_reconciliation_runs
WHERE started_at > NOW() - INTERVAL '48 hours'
GROUP BY type, status
ORDER BY type, status;
"@
psql $env:DATABASE_URL -At -F'|' -c $q8
Write-Output ""

# -----------------------------------------------------------------------------
# 9. PII sample
# -----------------------------------------------------------------------------
Write-Output "--- [9/9] PII sample (logs 1h + metrics + alerts 24h) ---"
$logPii = ($logs -split "`n" | Select-String -Pattern "(@|sk_(test|live)_|whsec_|Bearer )" | Where-Object { $_ -notmatch "\[REDACTED\]" } | Measure-Object).Count
Write-Output "  Logs PII match : $logPii"

$metricsPii = ($metrics -split "`n" | Where-Object { $_ -notmatch "_truncated" } | Select-String -Pattern "(userId|missionId|paymentId|email|stripeId)=" | Measure-Object).Count
Write-Output "  Metrics PII match : $metricsPii"

$q9 = @"
SELECT COUNT(*) FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND (context::text ILIKE '%bearer %'
    OR context::text ILIKE '%sk_test_%'
    OR context::text ILIKE '%sk_live_%'
    OR context::text ~ '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}');
"@
$alertPii = (psql $env:DATABASE_URL -At -c $q9).Trim()
Write-Output "  Alerts PII match : $alertPii"

if ([int]$logPii -gt 0 -or [int]$metricsPii -gt 0 -or [int]$alertPii -gt 0) {
  Write-Output "  STATUS : 🚨 ROLLBACK IMMÉDIAT (fuite PII confirmée)"
} else {
  Write-Output "  STATUS : ✅"
}
Write-Output ""

@"
=============================================================================
Snapshot terminé. Copier les blocs ci-dessus dans le checkpoint courant :
  docs/security-reviews/operational-72h-checkpoint-template.md
=============================================================================
"@ | Write-Output
