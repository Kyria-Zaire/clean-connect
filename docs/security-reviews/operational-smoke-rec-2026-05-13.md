# Rapport — Smoke opérationnel `FF_FINANCE_MONITORING_ENABLED=true` (RECETTE — 2026-05-13)

> **Statut** : 🟡 **EN ATTENTE D'EXÉCUTION SRE** — ce fichier est pré-rempli à partir du template `2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md`. Le SRE complète chaque check pendant l'exécution réelle et change le statut en `EN COURS` puis `VALIDÉ` ou `ROLLBACK`.
> **Source procédure** : [`docs/runbooks/finance-monitoring-activation.md`](../runbooks/finance-monitoring-activation.md)
> **Source référence sécu** : [`docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`](2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md) — checklist §6

---

## Métadonnées

| Champ | Valeur |
|---|---|
| Environnement cible | **recette** (`rec.cleanconnect.fr`) |
| Branche / SHA déployée | `main` @ `c3cbb06` (squash merge PR #29 du 2026-05-13 11:46 UTC) |
| Activation T0 (UTC) | _à renseigner_ |
| Activation T0 (Europe/Paris) | _à renseigner_ |
| SRE primaire | _@…_ |
| SRE secondaire | _@…_ |
| CTO joignable ? | _☐ oui / ☐ non_ |
| DPO sign-off pré-activation reçu ? | ☐ pas requis pour recette (requis avant prod) |
| Fenêtre `FF=true` planifiée | _ex. 2026-05-13 14:00 → 2026-05-16 14:00 (72 h)_ |
| Verdict global | ⏳ **EN ATTENTE** |

### Pré-vérifications T-1j (cf. runbook §1)

| Check | Statut | Note |
|---|---|---|
| `git log --oneline main` montre `c3cbb06` (squash PR #29) | ✅ | confirmé 2026-05-13 13:46 |
| `pnpm --filter @cc/api exec prisma migrate status` recette = up to date | ☐ | _exécution SRE_ |
| Secrets `RESEND_API_KEY` + `FINANCE_DAILY_REPORT_EMAIL_TO` + `RESEND_FROM_EMAIL` provisionnés recette | ☐ | _vérif secret manager_ |
| `STRIPE_API_VERSION` recette aligné dashboard Stripe | ☐ | `2025-02-24.acacia` |
| Prometheus scrape `up{job="cc-api",env="recette"} == 1` | ☐ | _Grafana_ |
| Discord webhook `#ops-finance` actif | ☐ | message test |
| Capacité on-call déclarée | ☐ | _planning_ |
| Annonce Slack `#engineering` T-1h | ☐ | _Slack_ |

---

## A. Activation (T0 → T+5min)

| # | Check | Attendu | Résultat | Horodatage |
|---|---|---|---|---|
| A1 | Secret `FF_FINANCE_MONITORING_ENABLED=true` déposé recette | ✅ | ☐ | |
| A2 | `kubectl -n cleanconnect-rec rollout restart deploy/cc-api` lancé | ✅ | ☐ | |
| A3 | `kubectl rollout status` < 120 s | < 120 s | ☐ | _temps réel_ |
| A4 | `curl /healthz` → 200 | 200 OK | ☐ | |
| A5 | `curl /readyz` → 200 | 200 OK | ☐ | |
| A6 | 100 % pods `Ready` | 100 % | ☐ | |
| A7 | Logs ne contiennent plus `finance.<scheduler>.disabled` (T+5min) | 0 match | ☐ | commande runbook §2.2 |

## B. Smoke finance — schedulers (T+10min → T+24h)

| # | Scheduler | Tick attendu (Europe/Paris) | Vérification | Résultat |
|---|---|---|---|---|
| B1 | `reconcile` | 03:30 quotidien **ou** manual run | log `finance.reconcile.run.start` + `done` | ☐ |
| B2 | `stuck-funds` | `HH:05` horaire | log `finance.stuck.run.*` | ☐ |
| B3 | `invariants` | 04:15 quotidien | log `finance.invariants.run.*` | ☐ |
| B4 | `payout-anomaly` | 04:45 quotidien | log + métrique `cleanconnect_finance_payout_anomaly_factor` observed | ☐ |
| B5 | `daily-report` | 07:00 quotidien | row `finance_daily_reports` J-1 + email reçu | ☐ |
| B6 | `retention` | 02:30 quotidien | log `finance.retention.done deletedMismatches=… …` | ☐ |
| B7 | Manual run admin (`POST /v1/admin/finance/runs/manual`) | sur demande | → 202 ACCEPTED `{runId}` | ☐ |
| B8 | 2ème manual run < 1h | sur demande | → **429** `FINANCE_MANUAL_RUN_RATE_LIMIT` | ☐ |
| B9 | Manual run concurrent vs cron (si fenêtre) | sur demande | → **409** `FINANCE_RECONCILE_BUSY` | ☐ |
| B10 | Aucun run reste `RUNNING` > 20 min | 0 zombie | requête SQL ci-dessous | ☐ |

```sql
-- B10 : runs zombies
SELECT id, type, started_at, NOW() - started_at AS age
FROM finance_reconciliation_runs
WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes';
-- Attendu : 0 rows
```

## C. Sécurité — PII 3 vecteurs

| # | Vecteur | Commande / méthode | Résultat |
|---|---|---|---|
| C1 | **Logs** : `kubectl logs --since=24h \| grep -E '(@\|sk_(test\|live)_\|whsec_\|Bearer )'` | 0 match | ☐ |
| C2 | **Metrics** : `curl /internal/metrics \| grep -E '(userId\|missionId\|paymentId\|email)='` | 0 match | ☐ |
| C3 | **Emails Resend** : sample 3 daily reports → vérif visuelle | aucun PII visible | ☐ |
| C4 | `FinanceAlert.context` : `SELECT context FROM finance_alerts WHERE created_at > NOW() - 24h LIMIT 20` | aucun email/uuid/stripeId non tronqué | ☐ |
| C5 | Discord `#ops-finance` payload visuel | aucune PII | ☐ |
| C6 | Cardinalité Prometheus | `curl /internal/metrics \| grep "^cleanconnect_finance_" \| wc -l` ≤ 80 | ☐ |

## D. Observabilité

| # | Check | Résultat |
|---|---|---|
| D1 | Grafana `Finance — Reconciliation overview` charge sans 5xx | ☐ |
| D2 | Panel `Open mismatches by severity P1/P2` cohérent | ☐ |
| D3 | Panel `Reconciliation duration P95` < 60 s | ☐ |
| D4 | Panel `Daily report invariant balance J-1` ≈ 0 ± 1 cent | ☐ |
| D5 | BullBoard readonly accessible (Bearer admin) | ☐ |
| D6 | DLQ `stripe-webhooks` consultable | ☐ |
| D7 | Retry visible côté queues | ☐ |
| D8 | Traces OTel `cc-api > finance.*` présentes (si OTel actif) | ☐ |
| D9 | Test alerte P1 forcée → message Discord `#ops-finance` | ☐ |
| D10 | Cooldown alerte respecté (2ème trigger < TTL → pas de message) | ☐ |

## E. Résilience — rollback FF=false (à exécuter en fin de smoke)

| # | Check | Attendu | Résultat |
|---|---|---|---|
| E1 | `FF_FINANCE_MONITORING_ENABLED=false` + rolling restart | < 2 min | ☐ |
| E2 | Logs `finance.<scheduler>.disabled` réapparaissent | 6/6 schedulers | ☐ |
| E3 | Pas d'alerte nouvelle après 30 min cooldown | 0 alerte | ☐ |
| E4 | Pas de run zombie créé pendant la fenêtre | requête B10 = 0 | ☐ |
| E5 | Workers BullMQ `stripe-webhooks` / `escrow-auto-release` non impactés | DLQ + counts stables | ☐ |
| E6 | Re-activation FF=true post-rollback OK | smoke A1-A7 ✅ | ☐ |

---

## Incidents observés

| ID | Sévérité | Horodatage UTC | Description | Action prise | Statut |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

---

## Captures / liens

- Screenshot dashboard Grafana T0 : `<lien drive>`
- Screenshot dashboard Grafana T+1h : `<lien>`
- Screenshot dashboard Grafana T+24h : `<lien>`
- Screenshot dashboard Grafana T+72h : `<lien>`
- Export Prometheus snapshot : `<lien>`
- Logs zip 24h (anonymisés si export externe) : `<lien>`
- Sample email daily report : `<lien interne ops>`

---

## Verdict opérationnel recette

- [ ] **Tous les checks A-E ✅** → recette **VALIDÉE** pour passage prod
- [ ] Au moins 1 check ❌ → recette **NON validée**, retour engineering avec rapport d'incident

| Décideur | Signature | Date |
|---|---|---|
| SRE primaire | `@…` | _YYYY-MM-DD_ |
| SRE secondaire | `@…` | _YYYY-MM-DD_ |
| Reviewer sécu | `@…` | _YYYY-MM-DD_ |

---

## Recommandations finales

### Pour recette

- ✅ / ❌

### Pour production

- ✅ / ❌ — conditionné à **DPO sign-off** ([`docs/dpo/finance-monitoring-rgpd-summary.md`](../dpo/finance-monitoring-rgpd-summary.md) §9) + **CTO sign-off** ([`2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`](2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md) §8) + fenêtre mardi/mercredi 10h-12h Europe/Paris

---

*Fichier généré le 2026-05-13 à partir du template `2026-05-13-prd-004-ticket-4-5-financial-monitoring-operational-smoke.md`.*
*À conserver après exécution comme preuve d'audit ops.*
