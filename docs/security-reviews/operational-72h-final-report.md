# Rapport final — Observation 72 h `FF_FINANCE_MONITORING_ENABLED=true` (RECETTE)

> **Statut** : 🟡 **À COMPLÉTER PAR SRE** pendant l'exécution réelle de la fenêtre 72 h.
> **Préfixe fichier final** : à renommer `operational-72h-final-report-rec-YYYY-MM-DD.md` à la fin de la fenêtre.
> **Documents amont** :
> - Smoke recette : [`operational-smoke-rec-2026-05-13.md`](operational-smoke-rec-2026-05-13.md)
> - Checkpoints intermédiaires : `operational-72h-checkpoint-T+<XX>-rec-YYYY-MM-DD.md` (cf. [`operational-72h-checkpoint-template.md`](operational-72h-checkpoint-template.md))
> - Surveillance : [`docs/runbooks/finance-monitoring-72h-surveillance.md`](../runbooks/finance-monitoring-72h-surveillance.md)
> - Décision prod : [`docs/runbooks/finance-monitoring-go-no-go-prod.md`](../runbooks/finance-monitoring-go-no-go-prod.md)

---

## 1. Synthèse exécutive

| Champ | Valeur |
|---|---|
| Environnement | **recette** |
| Branche / SHA | `main @ c3cbb06` (squash PR #29) |
| T0 activation FF=true (UTC) | _YYYY-MM-DDTHH:MM:SSZ_ |
| T0 activation FF=true (Europe/Paris) | _YYYY-MM-DD HH:MM_ |
| T+72h | _YYYY-MM-DD HH:MM_ |
| SRE primaire | _@…_ |
| SRE secondaire | _@…_ |
| Reviewer sécu | _@…_ |
| Nombre d'incidents totaux | _0 / 1 / 2 / 3+_ |
| Dont P0 | _0 / 1 / 2+_ |
| Dont P1 | _0 / 1 / 2+_ |
| Rollback déclenché ? | ☐ non / ☐ oui (`<heure>` → `<raison>`) |
| Verdict global | ⏳ EN COURS / ✅ STABLE / ⚠️ RÉSERVÉ / ❌ INSTABLE |

---

## 2. Indicateurs clés — vue d'ensemble

> Reprend les 9 indicateurs de surveillance (cf. `finance-monitoring-72h-surveillance.md` §2) sur l'ensemble de la fenêtre.

| Indicateur | Cible | T+15min | T+1h | T+4h | T+12h | T+24h | T+48h | T+72h |
|---|---|---|---|---|---|---|---|---|
| Cardinalité Prom `cleanconnect_finance_*` | ≤ 80 | _ | _ | _ | _ | _ | _ | _ |
| Alertes/h max sur un `kind` | < 5 | _ | _ | _ | _ | _ | _ | _ |
| Retries Stripe/h | < 10 | _ | _ | _ | _ | _ | _ | _ |
| Runs zombies (`RUNNING > 20min`) | 0 | _ | _ | _ | _ | _ | _ | _ |
| Sessions PG bloquées sur advisory lock | 0 | _ | _ | _ | _ | _ | _ | _ |
| Messages Discord/h `#ops-finance` | < 10 | _ | _ | _ | _ | _ | _ | _ |
| `cc-api` memory (Mi) | stable | _ | _ | _ | _ | _ | _ | _ |
| Redis used_memory_human | stable | _ | _ | _ | _ | _ | _ | _ |
| Daily report envoyé (J-1) | ✅ | n/a | n/a | n/a | n/a | _ | _ | _ |

### Évolution graphique (optionnel)

> Coller ici les screenshots Grafana ou liens vers les snapshots Prometheus.

- Dashboard `Finance — Reconciliation overview` T0 → T+72h
- Dashboard `Finance — Open mismatches` T0 → T+72h
- Dashboard `Finance — Daily balance J-1` T+24h, T+48h, T+72h
- Dashboard `cc-api memory` 72 h

---

## 3. Finance — observations

### 3.1 Mismatches détectés

| `mismatch_code` | Severity | Total détectés 72h | Statut final (OPEN/ACK/INV/RES/IGN) | Note |
|---|---|---|---|---|
| FIN-I-001 | _ | _ | _ | _ |
| FIN-I-002 | _ | _ | _ | _ |
| FIN-I-003 | _ | _ | _ | _ |
| FIN-I-004 | _ | _ | _ | _ |
| FIN-I-005 | _ | _ | _ | _ |
| FIN-I-006 | _ | _ | _ | _ |
| FIN-I-007 | _ | _ | _ | _ |
| FIN-I-008 | _ | _ | _ | _ |
| FIN-I-009 | _ | _ | _ | _ |
| FIN-I-010 | _ | _ | _ | _ |
| FIN-I-011 | _ | _ | _ | _ |
| FIN-J-001 | _ | _ | _ | _ |

```sql
-- Requête de génération :
SELECT mismatch_code, severity, status, COUNT(*) AS total
FROM finance_mismatches
WHERE detected_at BETWEEN '<T0>' AND '<T+72h>'
GROUP BY mismatch_code, severity, status
ORDER BY mismatch_code, severity;
```

### 3.2 Invariants critiques

| Invariant | Méthode | Résultat |
|---|---|---|
| **Aucun double payout** | requête E1 du smoke | ☐ 0 row |
| **Aucun double refund** | requête E2 du smoke | ☐ 0 row |
| **Aucun auto-fix Stripe** | `grep -E 'finance.*stripe.create\|update\|capture\|cancel' logs 72h` | ☐ 0 match |
| **Reconcile read-only** | inventaire appels Stripe (logs `stripe_metrics`) | ☐ uniquement `retrieve*` |
| **Webhook duplicate idempotent** | replay manuel d'un webhook + ré-injection | ☐ 1 row, 2ème = `idempotent:true` |
| **Mismatch lifecycle cohérent** | transitions invalides testées → `409` | ☐ |

### 3.3 Schedulers

| Scheduler | Cible cron (EU/Paris) | Tirs sur 72h | Succès | Échecs | `RUNNING` zombies |
|---|---|---|---|---|---|
| `reconcile` | 03:30 quotidien (+ manual rec) | _ | _ | _ | 0 |
| `stuck-funds` | HH:05 horaire (~72 fois) | _ | _ | _ | 0 |
| `invariants` | 04:15 quotidien | 3 | _ | _ | 0 |
| `payout-anomaly` | 04:45 quotidien | 3 | _ | _ | 0 |
| `daily-report` | 07:00 quotidien | 3 | _ | _ | 0 |
| `retention` | 02:30 quotidien | 3 | _ | _ | 0 |

```sql
SELECT type, status, COUNT(*) AS total
FROM finance_reconciliation_runs
WHERE started_at BETWEEN '<T0>' AND '<T+72h>'
GROUP BY type, status
ORDER BY type, status;
```

### 3.4 Daily reports

| Date J-1 | balance_cents | balance_healthy | open P1 | open P2 | Email envoyé ? |
|---|---|---|---|---|---|
| _YYYY-MM-DD_ | _ | _ | _ | _ | ☐ |
| _YYYY-MM-DD_ | _ | _ | _ | _ | ☐ |
| _YYYY-MM-DD_ | _ | _ | _ | _ | ☐ |

---

## 4. BullMQ — observations

### 4.1 Queues

| Queue | Backlog max 72h | Job count traités | Failed | DLQ | Stalled | Poison jobs |
|---|---|---|---|---|---|---|
| `stripe-webhooks` | _ | _ | _ | _ | _ | _ |
| `escrow-auto-release` | _ | _ | _ | _ | _ | _ |

```bash
# Via BullBoard ou redis-cli — à T+72h :
redis-cli -h $REC_REDIS_HOST LLEN bull:stripe-webhooks:wait
redis-cli -h $REC_REDIS_HOST LLEN bull:stripe-webhooks:failed
redis-cli -h $REC_REDIS_HOST LLEN bull:escrow-auto-release:wait
```

### 4.2 Retry storms

| Source | Total retries 72h | Pic max/h | Cause identifiée |
|---|---|---|---|
| Stripe API timeout | _ | _ | _ |
| Resend timeout | _ | _ | _ |
| Postgres connection | _ | _ | _ |

---

## 5. Observabilité — observations

### 5.1 Cardinalité Prometheus

| Mesure | T0 | T+24h | T+48h | T+72h | Δ |
|---|---|---|---|---|---|
| `cleanconnect_finance_*` séries totales | _ | _ | _ | _ | _ |
| Top 3 labels en cardinalité | _ | _ | _ | _ | _ |

> Cible : ≤ 80, jamais dépassée. Si dépassement observé même temporaire → **N3** No-Go.

### 5.2 Memory & Redis

| Métrique | T0 | T+24h | T+48h | T+72h | Δ % |
|---|---|---|---|---|---|
| `cc-api` mem pod 1 (Mi) | _ | _ | _ | _ | _ |
| `cc-api` mem pod 2 (Mi) | _ | _ | _ | _ | _ |
| Redis `used_memory_human` | _ | _ | _ | _ | _ |

### 5.3 Alert fatigue

| `kind` | Total émis 72h | Cooldown respecté ? | Spam Discord ? |
|---|---|---|---|
| `finance_mismatch` | _ | _ | _ |
| `finance_stuck_authorization` | _ | _ | _ |
| `finance_stuck_captured_funds` | _ | _ | _ |
| `finance_transfer_pending` | _ | _ | _ |
| `finance_refund_mismatch` | _ | _ | _ |
| `finance_invariant_break` | _ | _ | _ |
| `finance_reconcile_failed` | _ | _ | _ |
| `finance_report_missing` | _ | _ | _ |
| `finance_payout_anomaly` | _ | _ | _ |
| `finance_daily_report_failed` | _ | _ | _ |

### 5.4 Dashboard latency

| Dashboard | Temps moyen chargement | 5xx observés |
|---|---|---|
| `Finance — Reconciliation overview` | _ ms | _ |
| `Finance — Open mismatches` | _ ms | _ |
| `cc-api memory + cpu` | _ ms | _ |

---

## 6. Sécurité — observations

> Re-application de la matrice C du smoke. À T+72h, refaire les 6 checks (en plus du smoke initial).

| # | Vecteur | Méthode | Résultat T+72h |
|---|---|---|---|
| C1 | Logs Pino — patterns PII | `grep -E '(@\|sk_(test\|live)_\|whsec_\|Bearer )'` sur 72h logs | ☐ 0 match |
| C2 | Metrics Prom — labels PII | `curl /internal/metrics \| grep -E '(userId\|missionId\|paymentId\|email)='` | ☐ 0 match |
| C3 | Emails Resend — payload | sample 3 daily reports | ☐ uniquement agrégats |
| C4 | `FinanceAlert.context` DB | requête SQL ci-dessous | ☐ 0 PII |
| C5 | Payload Discord visuel | revue manuelle `#ops-finance` | ☐ 0 PII |
| C6 | `dbSnapshot` whitelistés | requête SQL ci-dessous | ☐ uniquement champs `FINANCE_SNAPSHOT_WHITELIST` |

```sql
-- C4 : alertes contexte
SELECT context::text
FROM finance_alerts
WHERE created_at > NOW() - INTERVAL '72 hours'
  AND (context::text ILIKE '%@%'
    OR context::text ~ '[a-z]+@[a-z]+\.[a-z]+'
    OR context::text ILIKE '%bearer%'
    OR context::text ILIKE '%sk_test%'
    OR context::text ILIKE '%sk_live%');
-- Attendu : 0 rows

-- C6 : snapshots conformes whitelist
SELECT id, resource_kind, jsonb_object_keys(db_snapshot)
FROM finance_mismatches
WHERE detected_at > NOW() - INTERVAL '72 hours'
GROUP BY id, resource_kind, jsonb_object_keys
HAVING jsonb_object_keys NOT IN (
  -- PAYMENT
  'id','status','amountAuthorizedCents','amountCapturedCents','currency','applicationFeeCents','providerPayoutCents','failureCode','createdAt','updatedAt','stripePaymentIntentIdTruncated',
  -- TRANSFER
  'amountCents','retryCount','stripeTransferIdTruncated',
  -- REFUND
  'initiatedBy','settledAt','stripeRefundIdTruncated',
  -- INVARIANT
  'invariant','leftCents','rightCents','deltaCents','reportDate'
);
-- Attendu : 0 rows
```

---

## 7. Incidents observés (chronologie)

> Compléter pour chaque incident sur la fenêtre 72 h. Référence vers `incident-playbook` pour classification.

| ID | Horodatage UTC | Sévérité | Description courte | Indicateur déclencheur | Action prise | Durée | Statut résolution |
|---|---|---|---|---|---|---|---|
| _INC-001_ | _ | P0/P1/P2/P3 | _ | _ | rollback / triage / wait | _ min_ | résolu / ouvert |
| _…_ | _ | _ | _ | _ | _ | _ | _ |

### 7.1 Post-mortems

> Pour chaque P0 ou P1, joindre un post-mortem suivant le template ci-dessous :

#### Incident INC-XXX

- **Quoi** : _description factuelle_
- **Quand** : _T+Xh +Ym → T+Xh +Zm_
- **Impact** : _utilisateur / monitoring / aucun_
- **Cause racine** : _technique / process / externe_
- **Action immédiate** : _rollback / triage / dégradation accepted_
- **Action long terme** : _fix / ADR / runbook_
- **Verrou de non-récurrence** : _test / alerte / ADR_

---

## 8. Rollback — exercice ou réel

| Champ | Valeur |
|---|---|
| Rollback déclenché ? | ☐ non (test) / ☐ oui (réel — incident _INC-XXX_) |
| Horodatage déclenchement (UTC) | _ |
| Horodatage retour FF=false stable (UTC) | _ |
| Durée totale | _ min_ (cible < 2 min) |
| Schedulers arrêtés | ☐ 6/6 (logs `finance.<scheduler>.disabled` revus) |
| Zombies créés pendant ? | ☐ 0 (requête B10 vérifiée) |
| Workers BullMQ impactés ? | ☐ non |
| Re-activation post-rollback testée ? | ☐ oui / ☐ non / ☐ pas nécessaire |

---

## 9. Verdict global

### 9.1 Critères Go (rappel — toutes ✅ requises)

| # | Critère | Résultat |
|---|---|---|
| G1 | 72 h sans P0 finance | ☐ |
| G2 | ≤ 1 P1 expliqué et résolu | ☐ |
| G3 | 0 double payout / 0 double refund | ☐ |
| G4 | 0 fuite PII confirmée | ☐ |
| G5 | Cardinalité ≤ 80 séries sur toute la fenêtre | ☐ |
| G6 | Memory / Redis stables (< +10 %) | ☐ |
| G7 | 6/6 schedulers ont tiré au moins 1× / fenêtre attendue | ☐ |
| G8 | 3/3 daily reports envoyés (J-1, J-2, J-3) | ☐ |
| G9 | Rollback testé (réel ou exercice) < 2 min | ☐ |
| G10 | Tous les checks B/C/D/E (smoke initial) restent ✅ à T+72h | ☐ |

### 9.2 Critères No-Go (n'importe lequel = NO-GO prod)

| # | Critère | Détecté ? |
|---|---|---|
| N1 | ≥ 1 P0 finance non résolu | ☐ |
| N2 | ≥ 2 P1 inexpliqués cumulés | ☐ |
| N3 | Cardinalité Prom > 80 séries observée (même brièvement) | ☐ |
| N4 | Daily report email absent ou KO sur ≥ 1 jour | ☐ |
| N5 | Memory / Redis growth anormal | ☐ |
| N6 | Session PG bloquée sur advisory lock > 30 s | ☐ |
| N7 | Incident **NOT FOUND** dans runbooks | ☐ |
| N8 | Refus DPO ou CTO | ☐ |

### 9.3 Verdict final

> Cocher **un seul** résultat :

- [ ] ✅ **STABLE — Go prod éligible** (tous G ✅, aucun N ❌) — déclencher réunion `finance-monitoring-go-no-go-prod.md`
- [ ] ⚠️ **RÉSERVÉ — Prolonger recette** (tous G ✅ mais incident mineur à observer 24 h de plus)
- [ ] ❌ **INSTABLE — Rollback + retour engineering** (≥ 1 N ❌) — `FF_FINANCE_MONITORING_ENABLED=false` + post-mortem + nouvelle itération

---

## 10. Recommandations

### 10.1 Pour recette

- _libre — anomalies mineures, optimisations à envisager_

### 10.2 Pour production (si Go)

- _fenêtre d'activation proposée (mardi/mercredi 10h-12h Europe/Paris)_
- _vigilance particulière sur indicateur X observé en recette_
- _doc opérationnelle à mettre à jour : `<liens>`_

### 10.3 Si No-Go

- _cause racine_
- _plan correctif (fix code / ADR / nouvelle recette)_
- _délai estimé avant nouvelle activation_

---

## 11. Sign-off

| Personne | Rôle | Verdict | Signature | Date |
|---|---|---|---|---|
| _@…_ | SRE primaire | ☐ Stable / ☐ Réservé / ☐ Instable | | |
| _@…_ | SRE secondaire | ☐ Stable / ☐ Réservé / ☐ Instable | | |
| _@…_ | Reviewer sécu | ☐ Stable / ☐ Réservé / ☐ Instable | | |

> Le sign-off **CTO + DPO** intervient en **réunion Go/No-Go** séparée, avec ce rapport comme preuve d'appui.

---

## 12. Annexes — collectes brutes

À joindre :

- ☐ Export `finance_alerts` 72 h (CSV)
- ☐ Export `finance_reconciliation_runs` 72 h (CSV)
- ☐ Export `finance_mismatches` 72 h (CSV)
- ☐ Export `finance_daily_reports` 3 rows (CSV)
- ☐ Snapshot Prometheus `cleanconnect_finance_*` (PromQL export)
- ☐ Screenshots Grafana T0 / T+24h / T+48h / T+72h
- ☐ Logs `cc-api` archivés (24 h × 3, anonymisés si export externe)
- ☐ Rapport `incident-playbook` rempli pour chaque incident

---

*Fichier généré le 2026-05-13. À renommer en `operational-72h-final-report-rec-YYYY-MM-DD.md` à la clôture de la fenêtre.*
