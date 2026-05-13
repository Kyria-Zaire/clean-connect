# Rapport — Smoke opérationnel `FF_FINANCE_MONITORING_ENABLED=true` (template)

> **Usage** : dupliquer ce fichier en `operational-smoke-<env>-<YYYY-MM-DD>.md` lors de chaque activation FF=true. Une exécution = un rapport signé.
> **Source de procédure** : `docs/runbooks/finance-monitoring-activation.md`.
> **Source de référence sécu** : `docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md` (checklist §6).

---

## Métadonnées

| Champ | Valeur |
|---|---|
| Environnement cible | `recette` / `preprod` / `production` |
| Branche / SHA déployée | `feat/fin-iter2-debts @ a27448b` (à actualiser après merge `main`) |
| Activation T0 (UTC) | `2026-MM-DDTHH:MM:00Z` |
| Activation T0 (Europe/Paris) | `YYYY-MM-DD HH:MM` |
| SRE primaire | `@…` |
| SRE secondaire | `@…` |
| CTO joignable ? | ✅ / ❌ |
| DPO sign-off pré-activation reçu ? | ✅ / ❌ (lien email) |
| Fenêtre `FF=true` planifiée | `<heures>` |
| Verdict global | ⏳ EN COURS / ✅ VALIDÉ / ❌ ROLLBACK |

---

## A. Activation

| # | Check | Attendu | Résultat | Commentaire |
|---|---|---|---|---|
| A1 | Secret `FF_FINANCE_MONITORING_ENABLED=true` provisionné dans secret manager | ✅ | ☐ | |
| A2 | Rolling restart `cc-api` (`kubectl rollout status`) terminé | ✅ < 120 s | ☐ | |
| A3 | `/healthz` 200 OK | 200 | ☐ | |
| A4 | `/readyz` 200 OK | 200 | ☐ | |
| A5 | Tous les pods passent `Ready` | 100 % | ☐ | |
| A6 | Logs ne contiennent plus `finance.<scheduler>.disabled` (T+5min) | 0 match | ☐ | |

## B. Smoke finance — schedulers (T+10min → T+24h)

| # | Scheduler | Tick attendu | Vérification | Résultat |
|---|---|---|---|---|
| B1 | `reconcile` | 03:30 Europe/Paris ou manual run | log `finance.reconcile.run.start` + `done` | ☐ |
| B2 | `stuck-funds` | `HH:05` | log `finance.stuck.run.*` | ☐ |
| B3 | `invariants` | 04:15 | log `finance.invariants.run.*` | ☐ |
| B4 | `payout-anomaly` | 04:45 | log + métrique `cleanconnect_finance_payout_anomaly_factor` observed | ☐ |
| B5 | `daily-report` | 07:00 | row `finance_daily_reports` J-1 + email reçu | ☐ |
| B6 | `retention` | 02:30 | log `finance.retention.done deletedMismatches=… …` | ☐ |
| B7 | Manual run admin (recette uniquement) | sur demande | `POST /v1/admin/finance/runs/manual` → 202, puis 429 | ☐ |
| B8 | Manual run concurrent (recette uniquement) | sur demande | 1 succès + 1 `409 FINANCE_RECONCILE_BUSY` | ☐ |
| B9 | Aucun run reste `RUNNING` > TTL | 0 zombie | requête SQL ci-dessous | ☐ |

```sql
-- B9 : runs zombies
SELECT id, type, started_at, NOW() - started_at AS age
FROM finance_reconciliation_runs
WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '20 minutes';
-- Attendu : 0 rows
```

## C. Vérifications techniques

| # | Check | Attendu | Résultat |
|---|---|---|---|
| C1 | `/internal/metrics` expose `cleanconnect_finance_*` (Bearer) | ≥ 1 série par compteur déclaré | ☐ |
| C2 | Cardinalité `cleanconnect_finance_*` ≤ 80 séries | `grep -c "^cleanconnect_finance_"` | ☐ |
| C3 | Aucun label `userId=` / `missionId=` / `paymentId=` / `email=` / `stripeId=` non tronqué | `grep -E '(userId\|missionId\|paymentId\|email)='` → 0 match | ☐ |
| C4 | Grafana — dashboard `Finance — Reconciliation` charge sans 5xx | 200 | ☐ |
| C5 | Grafana — panel `Open mismatches by severity` cohérent | 0 ou valeur attendue | ☐ |
| C6 | Grafana — panel `Reconciliation duration P95` < 60 s | < 60 s | ☐ |
| C7 | Grafana — panel `Daily report invariant balance J-1` | ≈ 0 ± 1 cent | ☐ |
| C8 | BullBoard readonly accessible (Bearer admin) | 200 | ☐ |
| C9 | Cron retention purge effective : log `finance.retention.done` avec compteurs cohérents | ✅ | ☐ |
| C10 | Locks anti-overlap : 2 manual runs concurrents → 1 succès / 1 `409` | ✅ | ☐ |
| C11 | `pg_stat_activity` — pas de session bloquée sur `pg_advisory_xact_lock` finance | 0 session bloquée | ☐ |

## D. Vérifications sécurité (PII 3 vecteurs)

| # | Vecteur | Méthode | Résultat |
|---|---|---|---|
| D1 | **Logs** | `kubectl logs --since=24h \| grep -E '(@\|sk_(test\|live)_\|whsec_\|Bearer )'` → 0 match | ☐ |
| D2 | **Metrics** | `curl /internal/metrics \| grep -vP '_truncated' \| grep -E '(userId\|missionId\|paymentId\|email\|stripeId)='` → 0 match | ☐ |
| D3 | **Emails Resend** | échantillon 3 daily reports → vérif visuelle uniquement agrégats numériques | ☐ |
| D4 | `FinanceAlert.context` (DB) | `SELECT context FROM finance_alerts WHERE created_at > NOW() - INTERVAL '24 hours' LIMIT 20` → aucun email/uuid/stripeId non tronqué | ☐ |
| D5 | `sanitizeForAlert` actif sur émissions alerte | grep code | ✅ (couvert tests unit) | ☐ |
| D6 | `deepSanitize` actif sur `FinanceAlertingService.emit` | code path vérifié | ✅ | ☐ |
| D7 | Alerte Discord — payload visuel | aucune PII visible dans `#ops-finance` | ☐ |

## E. Vérifications finance (invariants critiques)

| # | Invariant | Vérification | Résultat |
|---|---|---|---|
| E1 | Aucun double payout | requête SQL ci-dessous | ☐ |
| E2 | Aucun double refund | requête SQL ci-dessous | ☐ |
| E3 | Aucun auto-fix Stripe | grep logs `finance.*stripe.create\|update\|capture\|cancel` → 0 match | ☐ |
| E4 | Mismatch lifecycle cohérent | transitions invalides → 409 | ☐ |
| E5 | Reconcile read-only confirmé | aucune mutation Stripe initiée par les runs RECONCILE | ☐ |
| E6 | Webhook duplicate idempotent | replay manuel d'un webhook → 1 row DB, 2ème réponse `idempotent:true` | ☐ |

```sql
-- E1 : double transfer SENT pour un même payment_id
SELECT payment_id, COUNT(*) c FROM transfers
WHERE status = 'SENT' AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY payment_id HAVING COUNT(*) > 1;
-- Attendu : 0 rows

-- E2 : refunds en somme > montant capturé (sur 24 h)
SELECT p.id, p.amount_captured_cents, SUM(r.amount_cents) AS refunded
FROM payments p
JOIN refunds r ON r.payment_id = p.id AND r.status = 'REFUNDED'
WHERE p.updated_at > NOW() - INTERVAL '24 hours'
GROUP BY p.id, p.amount_captured_cents
HAVING SUM(r.amount_cents) > p.amount_captured_cents;
-- Attendu : 0 rows
```

## F. Alerting Discord — sanity

| # | Check | Méthode | Résultat |
|---|---|---|---|
| F1 | Test alerte P1 forcée | stub `finance_daily_report_failed` (env recette uniquement) → message Discord | ☐ |
| F2 | Cooldown respecté | 2ème déclenchement < cooldown → pas de message + log `finance.alert.cooldown` | ☐ |
| F3 | Aucun secret/PII dans payload Discord | revue visuelle | ☐ |

## G. Rollback testé (recette uniquement)

| # | Check | Attendu | Résultat |
|---|---|---|---|
| G1 | `FF_FINANCE_MONITORING_ENABLED=false` + rolling restart | < 2 min | ☐ |
| G2 | Logs `finance.<scheduler>.disabled` réapparaissent | 6/6 schedulers | ☐ |
| G3 | Pas d'alerte nouvelle après cooldown | 0 alerte 30 min après FF=false | ☐ |
| G4 | Pas de run zombie créé pendant la fenêtre | requête SQL B9 = 0 | ☐ |
| G5 | Workers BullMQ `stripe-webhooks` non impactés | DLQ + counts stables | ☐ |
| G6 | Re-activation FF=true post-rollback fonctionnelle | smoke A1-A6 OK | ☐ |

---

## Incidents observés

| ID | Sévérité | Horodatage UTC | Description | Action prise | Statut |
|---|---|---|---|---|---|
| — | — | — | (aucun) | — | — |

---

## Captures / liens

- Screenshot dashboard Grafana (T0, T+1h, T+24h) : `<lien drive>`
- Export Prometheus snapshot : `<lien>`
- Logs zip (24 h) : `<lien>`
- Sample email daily report : `<lien>` (privé ops)

---

## Verdict opérationnel

- [ ] **Tous les checks A-G ✅** → recette **VALIDÉE** pour passage prod
- [ ] Au moins 1 check ❌ → recette **NON validée**, retour engineering

| Décideur | Signature | Date |
|---|---|---|
| SRE primaire | `@…` | `YYYY-MM-DD` |
| SRE secondaire | `@…` | `YYYY-MM-DD` |
| Reviewer sécu | `@…` | `YYYY-MM-DD` |

---

## Recommandations finales

### Pour recette

- ✅ / ❌

### Pour production

- ✅ / ❌ (conditionné à DPO + CTO sign-off + fenêtre mardi/mercredi 10h-12h)

---

*Template produit le 2026-05-13. Dupliquer en `operational-smoke-rec-YYYY-MM-DD.md` pour chaque exécution.*
