# Playbook incident — Monitoring finance (recette / prod)

> **Cible** : SRE on-call.
> **Doc parent** : [`finance-monitoring-activation.md`](finance-monitoring-activation.md) + [`finance-monitoring-72h-surveillance.md`](finance-monitoring-72h-surveillance.md).
> **Règle d'or** : *en cas de doute → rollback. On ne débogue jamais en live sous FF=true.*

---

## 1. Matrice de classification

> **Une seule** ligne suffit à classer. Si plusieurs lignes correspondent → prendre la **plus haute sévérité**.

### P0 — Critique, impact paiement client direct, < 30 min

| Symptôme | Vérification rapide | Action immédiate |
|---|---|---|
| Double payout détecté en DB | `SELECT payment_id, COUNT(*) FROM transfers WHERE status='SENT' GROUP BY payment_id HAVING COUNT(*) > 1;` | **rollback** §4 + bloquer payouts admin + escalade Stripe support |
| Double refund initié | `SELECT p.id, SUM(r.amount_cents), p.amount_captured_cents FROM payments p JOIN refunds r ON r.payment_id=p.id AND r.status='REFUNDED' GROUP BY p.id, p.amount_captured_cents HAVING SUM > amount_captured_cents;` | **rollback** + escalade Stripe |
| Fuite PII confirmée (logs / metrics / emails) | sample `grep -E '(@\|sk_(test\|live)_\|Bearer )'` revient avec match dans payload finance | **rollback** + DPO notifié sous 1 h + post-mortem RGPD |
| Mutation Stripe initiée par finance (`create/update/capture/refund/cancel`) | `grep` logs dernière heure | **rollback** + ADR-018 reviewé |
| `cleanconnect_finance_reconciliation_runs_total{status="FAILED"}` > 5 / 1 h | dashboard Grafana | **rollback** + investigation Stripe API |
| Latence p99 globale API > 2 s sur > 5 min | dashboard `cc-api latency` | **rollback** + isolation cause |
| Memory `cc-api` > +50 % en 24 h | `kubectl top pods` | **rollback** + heap dump avant restart |

### P1 — Risque financier monitoring, < 4 h ouvré

| Symptôme | Action |
|---|---|
| ≥ 3 alertes P1 finance distinctes en 30 min, hors anomalie système attendue | triage `#ops-finance` → si pattern → rollback |
| Cardinalité Prom finance 80 < x ≤ 150 sur > 1 h | investiguer label dynamique apparu ; si pas de cause → rollback |
| Daily report email KO 2 jours consécutifs | vérifier `RESEND_API_KEY` / quota Resend ; rejouer manuellement |
| Run reconcile `FAILED` 2× consécutifs même cause | bloquer manual runs admin + investigation |
| `finance_daily_report_failed` (kind nouveau de FIN-DAILY-EMAIL) émis | investiguer payload Resend + alerte cooldown |
| Sessions PG bloquées sur advisory lock > 30 s | analyse `pg_stat_activity` + restart pod si nécessaire |
| Open mismatches P1 > 20 (recette : impossible, prod : exception) | bloquer manual runs + investigation par lot |

### P2 — Surveillance proactive, jour ouvré suivant

| Symptôme | Action |
|---|---|
| Open mismatches P2 cumulés > 50 | batch triage hebdo `#ops-finance` |
| Daily report `balance_healthy=false` 1 fois | reconcile manuel + revue invariants |
| Drift scheduler horaire `stuck-funds` > 90 min | vérifier `@Cron` côté pod élu (master) |
| Discord spam > 20 messages/h sur 2 h | tuning cooldown |
| Memory `cc-api` +10 % à +50 % | observation continue, pas de rollback |

### P3 — Info / amélioration

| Symptôme | Action |
|---|---|
| 1 mismatch P1 isolé résolu sous 1 h | noter dans rapport, RAS |
| 1 retry Stripe ponctuel | noter, RAS |
| Performance dashboard Grafana 2-5 s | optimisation backlog |

---

## 2. Procédure de réponse standard

### 2.1 Phase 1 — Triage (< 5 min)

1. **Lire l'alerte Discord** complète (kind / severity / context)
2. **Ouvrir le dashboard Grafana** `Finance — Reconciliation overview`
3. **Classifier** via §1 (P0 / P1 / P2 / P3)
4. **Décider** :
   - P0 → ⏭ §2.2 (rollback)
   - P1 → ⏭ §2.3 (triage approfondi)
   - P2 → noter, planifier action jour ouvré
   - P3 → noter, RAS

### 2.2 Rollback P0 (cible < 2 min)

```bash
# 1. Désactivation flag (secret manager — recette OU prod)
FF_FINANCE_MONITORING_ENABLED=false

# 2. Rolling restart cc-api
kubectl -n cleanconnect-<env> rollout restart deploy/cc-api
kubectl -n cleanconnect-<env> rollout status  deploy/cc-api --timeout=120s

# 3. Vérifier arrêt schedulers
kubectl -n cleanconnect-<env> logs -l app=cc-api --since=2m \
  | grep -E 'finance\.(reconcile|stuck|invariants|payout|daily_report|retention)\.disabled'

# 4. Vérifier zombies
psql "$DATABASE_URL" -c "
  SELECT id, type, started_at FROM finance_reconciliation_runs
  WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '30 minutes';
"
# Si > 0, attendre prochain tick scheduler (max 30 min) OU UPDATE manuel :
psql "$DATABASE_URL" -c "
  UPDATE finance_reconciliation_runs
  SET status='FAILED', completed_at=NOW(), failure_message='rollback_cleanup'
  WHERE status='RUNNING' AND started_at < NOW() - INTERVAL '30 minutes';
"
```

**Communiquer immédiatement** :
- Slack `#ops-critical` : « 🚨 Rollback FF=false `<env>` exécuté à `<heure>` — incident INC-XXX en cours »
- Slack `#engineering` : message identique
- CTO direct : si prod

### 2.3 Triage P1 (< 30 min)

1. **Identifier le pattern** : 1 alerte isolée ou pattern de spam ?
2. **Lire les contextes** : `SELECT context FROM finance_alerts WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at DESC;`
3. **Reproduire** : peut-on déclencher l'alerte avec un payload identique ?
4. **Décider** :
   - Fix immédiat trivial (config / cooldown) → patch via PR + redéploiement minimal
   - Cause floue ou code → rollback préventif + post-mortem à froid
   - Faux positif → ack mismatch + revoir invariant

> **Règle dure** : aucun patch code en live sous FF=true. Si fix code nécessaire → rollback d'abord.

### 2.4 P2 / P3 — Asynchrone

- Noter dans `operational-72h-final-report.md` §7
- Créer ticket suivi (label `finance/observation`)
- Aborder en revue ops hebdo

---

## 3. Communication d'incident

### 3.1 Template Slack initial

```
🚨 Incident INC-XXX — `<env>` — Sévérité P0/P1
⏰ Détecté à : <heure UTC>
🔎 Symptôme : <description courte>
📊 Indicateur : <métrique / alerte source>
✋ Action en cours : <triage / rollback / mitigation>
👤 On-call : @<sre>
🔗 Dashboard : <lien Grafana>
```

### 3.2 Template fin d'incident

```
✅ Incident INC-XXX — Résolu à <heure UTC>
⏱ Durée : <min>
🛠 Action : <rollback / fix / wait>
📝 Post-mortem : <lien doc>
🚦 Statut FF : <true / false>
🚨 Récurrence ? : <oui surveillance / non>
```

---

## 4. Post-mortem (obligatoire P0 + P1, optionnel P2)

> Délai max : **48 h** après résolution.
> Auteur : SRE primaire ayant traité l'incident.
> Reviewer : un autre SRE + reviewer sécu si P0.

### Template

```markdown
# Post-mortem INC-XXX — <env> — <YYYY-MM-DD>

## TL;DR
<3-5 phrases factuelles>

## Chronologie (UTC)
- T0 : alerte émise / symptôme détecté
- T+x : prise en charge SRE
- T+y : action immédiate (rollback / patch)
- T+z : retour stable
- T+w : clôture

## Impact
- Utilisateur : <oui / non / partiel>
- Monitoring : <oui / non>
- Financier réel : <oui / non>
- Durée totale : <min>

## Cause racine
<5 pourquoi> ou <fishbone>

## Mitigation immédiate
<actions exécutées>

## Mitigation long terme
- [ ] Fix code (lien PR)
- [ ] Test régression ajouté
- [ ] Alerte ajustée
- [ ] Runbook mis à jour
- [ ] ADR si décision structurelle

## Verrous de non-récurrence
<comment on garantit que ça ne reviendra pas>

## Leçons / amélioration process
<libre>

## Sign-off
- SRE primaire : @… le YYYY-MM-DD
- SRE reviewer : @… le YYYY-MM-DD
- Reviewer sécu (si P0) : @… le YYYY-MM-DD
- CTO (si P0 prod) : @… le YYYY-MM-DD
```

À placer dans `docs/post-mortems/INC-XXX-YYYY-MM-DD.md`.

---

## 5. Rappels — interdictions strictes pendant 72 h FF=true

- ❌ Pas de nouveau commit feature sur `main`
- ❌ Pas de refactor opportuniste finance/payments
- ❌ Pas de nouvelle migration Prisma sans ADR
- ❌ Pas de "petit fix" en hot patch
- ❌ Pas de modification de cron / scheduler sans incident avéré P1+
- ❌ Pas de modification labels Prometheus
- ❌ Pas de nouveau kind d'alerte ajouté

**Tout besoin de changement** = ticket post-mortem + nouvelle itération PRD-004.

---

*Playbook produit le 2026-05-13. À actualiser après chaque incident résolu en post-mortem.*
