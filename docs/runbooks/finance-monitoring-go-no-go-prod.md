# Décision Go / No-Go production — `FF_FINANCE_MONITORING_ENABLED=true`

> **Cible** : CTO, DPO, SRE, reviewer sécu — réunion synchrone de décision.
> **Pré-requis bloquant** : 72 h de stabilité recette `FF=true` ([`finance-monitoring-72h-surveillance.md`](finance-monitoring-72h-surveillance.md) §5).
> **Décision** : binaire, écrite, datée, signée par les 3 personae (CTO + DPO + SRE primaire).

---

## 1. Critères Go (10 critères — **TOUS** doivent être ✅)

| # | Critère | Source de preuve | ✅ / ❌ | Commentaire |
|---|---|---|---|---|
| G1 | **72 h recette stable** | rapport `operational-smoke-rec-2026-05-13.md` Verdict = VALIDÉ | ☐ | |
| G2 | **0 alerte P0** sur la fenêtre 72 h | Discord `#ops-critical` + `finance_alerts` DB | ☐ | |
| G3 | **0 alerte P1 inexpliquée** (P1 acceptables si causalité documentée) | rapport smoke §Incidents | ☐ | |
| G4 | **0 overlap scheduler** détecté (locks toujours acquis sans queueing > TTL) | logs `finance-lock.acquire.busy` rares ou nuls | ☐ | |
| G5 | **0 double payout / double refund** sur la fenêtre | requêtes SQL E1-E2 du smoke | ☐ | |
| G6 | **0 fuite PII** confirmée (3 vecteurs : logs / metrics / emails) | rapport smoke §C | ☐ | |
| G7 | **Rollback FF=false testé en recette** et validé < 2 min | rapport smoke §E | ☐ | |
| G8 | **Cardinalité Prometheus** ≤ 80 séries finance sur toute la fenêtre | dashboards Grafana + sample manuel | ☐ | |
| G9 | **DPO sign-off** écrit ([`docs/dpo/finance-monitoring-rgpd-summary.md`](../dpo/finance-monitoring-rgpd-summary.md) §9) | email/PR ou signature dans le doc | ☐ | |
| G10 | **CTO sign-off** explicite ([`2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`](../security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md) §8) | email/PR ou signature dans le doc | ☐ | |

---

## 2. Critères No-Go (n'importe lequel ❌ déclenche No-Go)

| # | Critère | Action si déclenché |
|---|---|---|
| N1 | ≥ 1 alerte P0 finance non résolue | retour engineering + ADR + nouvelle recette |
| N2 | ≥ 3 P1 inexpliqués cumulés sur 72 h | retour engineering, pas de nouvelle activation avant fix |
| N3 | Cardinalité Prom > 80 sur > 1 h | bug code → fix + nouvelle recette |
| N4 | Daily report email absent J+1, J+2 ou J+3 | investigation Resend + retest |
| N5 | Mémoire / Redis growth anormale | profiling + fix |
| N6 | Session PG bloquée sur advisory lock > 30 s observée | review code lock + nouvelle recette |
| N7 | Tout incident **NOT FOUND** dans un runbook | nouvelle ADR + recette |
| N8 | Refus explicite DPO ou CTO | back to drawing board |

---

## 3. Décision

### 3.1 Si **TOUS** G1-G10 ✅ et **AUCUN** N1-N8 ❌

> **Décision** : ✅ **GO PRODUCTION**
>
> **Conditions d'activation prod** :
>
> - Fenêtre : **mardi ou mercredi 10h-12h Europe/Paris** uniquement
> - Présence synchrone : **2 SRE + CTO joignable 4 h**
> - Communication T-1h Slack `#engineering` + `#leadership`
> - PagerDuty / Opsgenie route P0/P1 finance armée
> - Procédure d'activation : [`finance-monitoring-activation.md`](finance-monitoring-activation.md) §3
> - Dashboard Grafana `Finance — Reconciliation overview` ouvert en permanence sur les 4 premières heures
> - Rapport post-activation prod à produire : `operational-smoke-prod-YYYY-MM-DD.md` (basé sur même template)

### 3.2 Si **≥ 1** G ❌ ou **≥ 1** N ❌

> **Décision** : ❌ **NO-GO PRODUCTION**
>
> **Actions immédiates** :
>
> 1. `FF_FINANCE_MONITORING_ENABLED=false` en recette (rollback runbook §4)
> 2. Ouvrir incident `FIN-RECETTE-<date>` avec post-mortem
> 3. Si fix code requis → nouvelle itération PRD-004 Build → Verify → recette
> 4. Si fix doc/process → ADR + revue → re-décision Go/No-Go

---

## 4. Sign-off

| Personne | Rôle | Position | Signature | Date / heure |
|---|---|---|---|---|
| _@…_ | **CTO** | ☐ GO / ☐ NO-GO | | |
| _@…_ | **DPO** | ☐ GO / ☐ NO-GO | | |
| _@…_ | **SRE primaire** | ☐ GO / ☐ NO-GO | | |
| _@…_ | **Reviewer sécu** | ☐ GO / ☐ NO-GO | | |

**Décision finale** : ☐ **GO** / ☐ **NO-GO**

**Date/heure d'activation prod planifiée** : _YYYY-MM-DD HH:MM Europe/Paris_

**Plan B en cas de rollback prod** :

- `FF_FINANCE_MONITORING_ENABLED=false` immédiat
- Rollback technique sans migration (vérifié par squash `c3cbb06` PR #29 = 0 migration Prisma)
- Communication transparente `#engineering`
- Post-mortem dans les 48 h

---

## 5. Annexes — preuves attendues

À joindre **avant** la réunion de décision :

1. ✅ `operational-smoke-rec-2026-05-13.md` complété et signé
2. ✅ Screenshots Grafana T0, T+24h, T+48h, T+72h (dashboard `Finance — Reconciliation`)
3. ✅ Export `finance_alerts` 72 h
4. ✅ Export `finance_reconciliation_runs` 72 h
5. ✅ Export `finance_daily_reports` 72 h (3 rows attendus)
6. ✅ Confirmation DPO écrite (email + signature §9)
7. ✅ Confirmation CTO écrite (signature §8 Verify final)

---

*Document produit le 2026-05-13. Validité : décision binaire one-shot pour l'activation prod initiale FF=true.*
*Toute ré-activation future suit la même procédure.*
