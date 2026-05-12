# ADR-017 — Stratégie d'alerting : Discord (temps réel) + email (récap quotidien) + matrice sévérité + escalade

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-017` |
| **Titre** | Alerting Clean Connect : Discord webhook (canal `#ops` temps réel) + email récap quotidien + matrice sévérité P0-P3 + escalade |
| **Statut** | `Proposed` (Design Ticket 4.1) |
| **Date** | 2026-05-12 |
| **Auteur** | `architecte-api` + `ingenieur` (observability) + CTO |
| **PRD lié** | `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.1 |
| **Phase BMAD** | `Design` |

---

## 1. Contexte

Aucun mécanisme d'alerting n'existe aujourd'hui dans Clean Connect. Les incidents post-MVP seront détectés :
- soit par hasard (un dev qui regarde les logs),
- soit par un client qui ouvre un ticket support.

PRD-004 OQ-6 a tranché : **Discord/Slack en P0/P1 (temps réel) + email en récap quotidien**. Pas d'email d'alerte temps réel (lassitude).
OQ-8 demande de figer les seuils initiaux.

Cette ADR :
1. fige le canal (Discord webhook OU Slack webhook — équivalents, choix vendor unique pour MVP),
2. définit la matrice sévérité P0-P3,
3. liste les conditions de déclenchement précises + seuils initiaux,
4. cadre la politique d'escalade et de "snooze".

---

## 2. Décision

### 2.1 Canal vendor unique : Discord webhook

**Choix** : **Discord webhook** (`https://discord.com/api/webhooks/<id>/<token>`).

**Justification** :
- Gratuit, illimité, pas de SaaS supplémentaire à payer.
- L'équipe Clean Connect utilise déjà Discord pour la communication interne (confirmation utilisateur).
- Slack webhook est équivalent côté technique — le choix est interchangeable, on choisit Discord pour minimiser le nombre d'outils.

> **Si l'équipe migre sur Slack ultérieurement** : changer `ALERT_WEBHOOK_URL` env var + adapter le formatter de message (1 jour de boulot). Pas de lock-in.

**Canal Discord** : 1 serveur, **3 channels** :
- `#ops-p0` — incidents bloquants (mention `@here`)
- `#ops-p1` — anomalies critiques (mention `@on-call` rôle)
- `#ops-p2-p3` — warnings + récap (pas de mention)

> Le récap quotidien (cf. §2.4) va également dans `#ops-p2-p3` **et** par email.

### 2.2 Matrice sévérité

| Sévérité | Nom | MTTA (Mean Time To Acknowledge) | MTTR cible | Canal | Mention | Exemples |
|---|---|---|---|---|---|---|
| **P0** | Critique — service down ou perte d'argent | **5 min** | 1 h | `#ops-p0` Discord + email immédiat | `@here` | API down (5xx > 50 % sur 2 min) ; DB unavailable ; reconciliation cron détecte mismatch ≥ 1 € |
| **P1** | Important — fonction critique dégradée | **30 min** | 4 h | `#ops-p1` Discord | `@on-call` | `WebhookDeadLetter` nouvelle entrée non résolue > 5 min ; `Transfer.FAILED` taux > 5 % sur 10 min ; `auto-release-queue` stalled job |
| **P2** | Warning — anomalie à surveiller | **24 h** | best effort | `#ops-p2-p3` Discord | aucune | API p95 dégrade > 50 % vs baseline ; payout anomaly détectée ; coût Sentry mensuel > 80 % quota |
| **P3** | Info — récap, audit, métrique business | N/A | N/A | `#ops-p2-p3` Discord + email | aucune | Daily finance report ; weekly retention audit ; release deploy notification |

> **MTTA / MTTR** sont des **objectifs**, pas des SLA contractuels (pas de pénalité). Mesurés mensuellement.

### 2.3 Conditions de déclenchement précises (seuils initiaux OQ-8)

> Ces seuils sont **provisoires** et seront ajustés à J+7 / J+30 prod après mesure des baselines réelles (cf. ADR-014 §1.3). L'objectif J+7 = pas de "false positive" qui crée de la fatigue alerte.

#### P0 — Service down / perte financière

| Condition | Source | Seuil initial |
|---|---|---|
| API error rate `5xx > 1 %` sur 5 min | Sentry / Prometheus | alerte immédiate |
| API down (healthz fail) > 1 min | externe (Better Stack / UptimeRobot — à configurer Build) | alerte immédiate |
| `cleanconnect_finance_mismatch_amount > 1 €` (reconciliation cron) | Prometheus (Ticket 4.5) | alerte immédiate |
| `webhook ack p95 > 5 s` sur 5 min (Stripe va timeout) | Sentry / Prometheus | alerte immédiate |
| `Transfer.FAILED` rate > 20 % sur 5 min | Prometheus | alerte immédiate |

#### P1 — Anomalie critique

| Condition | Source | Seuil initial |
|---|---|---|
| Nouvelle entrée `WebhookDeadLetter` non résolue > 5 min | Prometheus `cleanconnect_bullmq_dlq_size` | alerte si > 0 pendant > 5 min |
| `Transfer.FAILED` rate > 5 % sur 10 min | Prometheus | alerte |
| `AutoReleaseJob` SCHEDULED depuis > T+48h+30min sans EXECUTED | Cron safety-net (Ticket 4.2) | alerte |
| `auto-release-queue` stalled job (rare car worker robuste) | BullMQ event | alerte |
| API p99 > 5 s sur 10 min | Sentry | alerte |
| BullMQ `queue depth > 100` waiting + active sur > 5 min | Prometheus | alerte |
| `Payment.REQUIRES_CAPTURE & createdAt < now-6j` (autorisation Visa expire ~7j) | Cron Ticket 4.5 | alerte |

#### P2 — Warning à surveiller

| Condition | Source | Seuil initial |
|---|---|---|
| API p95 > 800 ms sur `/payments/intent` pendant 30 min | Sentry | warning |
| Payout anomaly détectée (montant > 2× moyenne mensuelle) | Cron Ticket 4.5 | warning |
| Coût Sentry events mensuels > 80 % du quota | Sentry → script cron lecture API | warning |
| `Photo` orphans Cloudinary count > 50 | Cron Ticket 4.4 | warning |
| Increase `RetryCount` BullMQ > 30 % vs J-1 | Prometheus | warning |

#### P3 — Informationnel

| Condition | Source | Cadence |
|---|---|---|
| Daily finance report | Cron 6h Europe/Paris (Ticket 4.5) | quotidien |
| Weekly retention audit | Cron lundi 7h (Ticket 4.4) | hebdo |
| Release deploy notification | hook GitHub Action / déploiement | par release |
| Monthly RGPD report | Cron 1er du mois (Ticket 4.4) | mensuel |

### 2.4 Récap quotidien (email + Discord `#ops-p2-p3`)

**Cible** : CTO + ops, **lecture obligatoire chaque matin**.

**Contenu** :
- KPIs finance veille (capturé, transferé, refunded, commission plateforme).
- Top 5 endpoints par latence p95.
- Total alertes P0/P1 du jour J-1 (avec lien Sentry / Discord).
- DLQ non résolue à 0:00.
- Stuck transfers / payment > 6 jours count.

**Format** : email HTML simple + même contenu en message Discord `#ops-p2-p3`.

**Implémentation** : cron 6h00 Europe/Paris (lib `@nestjs/schedule` + Resend pour email — ADR-012 PRD-003). Build Ticket 4.5.

### 2.5 Politique d'escalade

> Toute alerte P0 / P1 non acknowledged → escalade.

| Étape | Délai depuis émission | Action |
|---|---|---|
| 0 | T+0 | Alerte Discord + (P0) email |
| 1 (escalade #1) | T+10 min (P0) / T+45 min (P1) | Re-ping `@here` / `@on-call` Discord ; mention CTO si pas d'ack à T+5 min P0 |
| 2 (escalade #2) | T+30 min (P0) / T+2 h (P1) | Email CTO + appel téléphonique (si numéro on-call configuré — OQ supplémentaire, non bloquante 4.1) |

> **MVP** : escalade #1 implémentée automatique. Escalade #2 = manuelle (pas de PagerDuty MVP).

### 2.6 "Snooze" / Maintenance window

Pour éviter le bruit pendant les déploiements ou les opérations de maintenance prévues :

- Un admin peut mettre la file d'alertes en **silence** pour une fenêtre (typiquement 30 min) via un endpoint admin protégé : `POST /api/v1/admin/observability/silence` `{ duration: 1800, reason: '...' }`.
- Pendant la silence : les alertes sont **stockées** (queue Bull dédiée `alerts-queue`), pas envoyées. À la sortie de la silence, on envoie un récap consolidé.
- Auto-fin de silence après `duration` — pas de silence permanent possible.
- Audit trail : `MissionEvent` `ADMIN_ALERT_SILENCE` (ou `AdminAction` selon arbitrage Ticket 4.3).

### 2.7 Format message Discord (Build template)

Template figé (markdown Discord, ~5 lignes max) :

```
🔴 P0 — <title>
ENV: prod | TIME: 2026-05-12T20:43:11Z | TRACE: <traceId>
Detail: <one-liner>
Sentry: https://sentry.io/...
@here
```

**Règles** :
- **Jamais** de payload brut dans le message (PII risk).
- **Toujours** un lien vers Sentry transaction + Grafana dashboard correspondant.
- Couleur du embed : rouge (P0), orange (P1), jaune (P2), bleu (P3).

### 2.8 Architecture d'émission

```
NestJS app (apps/api)
  │
  └── AlertingService.emit({ severity, title, detail, traceId })
        │
        └── enqueue BullMQ alerts-queue (job)
              │
              └── AlertsProcessor consume
                     ├── if silenced → store in 'silenced-alerts' set
                     └── else → POST Discord webhook + (P0/P3) Resend email
```

**Pourquoi via BullMQ** : si Discord est down, retry transparent. Si l'API est saturée, les alertes ne bloquent pas la requête HTTP qui les a déclenchées.

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **PagerDuty / Opsgenie** | Coût > 30 €/user/mois. Surdimensionné pour équipe < 5 personnes. À reconsidérer post-prod J+30 si fatigue ops constatée. |
| **Email seul (temps réel)** | Lassitude documentée (industry-wide) → on ignore les emails. OQ-6 a tranché : Slack/Discord pour le temps réel. |
| **Slack à la place de Discord** | Équivalent technique. Choix d'usage interne (équipe sur Discord). Webhook code identique. |
| **SMS via Twilio** | Coût + provider supplémentaire. Pas nécessaire MVP. |
| **Healthchecks.io** (cron heartbeat) | Outil sympa pour confirmer qu'un cron tourne. Complémentaire (pas alternative). À ajouter post-MVP si besoin. |
| **Better Stack** (uptime + status page) | À ajouter en parallèle pour l'uptime monitoring externe (~10 €/mois). Hors-scope Ticket 4.1 — sera décidé dans une OQ Build. |

---

## 4. Conséquences

### Positives

- **MTTD < 5 min sur P0** : Discord push instantané.
- **Pas de fatigue alerte** : seuls les P0/P1 mentionnent (`@here` / `@on-call`). P2/P3 silencieux mais lisibles.
- **Pas de vendor lock-in** : Discord/Slack webhooks = HTTP POST templates standards.
- **Coût zéro** au lancement (Discord webhook gratuit).
- **Auditabilité** : silence window tracée.

### Négatives / coûts assumés

- **Discord = SaaS tiers** : si Discord est down, on perd les alertes temps réel. Mitigé par : (a) email parallèle sur P0, (b) Sentry email natif activé en parallèle (redondance).
- **Bruit Discord** : si mal configuré, les channels se remplissent. Mitigé par sévérité stricte + tuning J+7.
- **Seuils initiaux à raffiner** : J+7 / J+30 ajustement obligatoire.

### Neutres (à surveiller)

- **Quota webhook Discord** : 30 messages/min/channel — largement suffisant. Si dépassement, c'est un signal qu'on a un problème de fond.
- **Resend rate limit email** : 100 emails/jour gratuit puis ~20 €/mois pour 50k. Acceptable.

---

## 5. Suivi

- [ ] PR Build : `apps/api/src/modules/observability/alerting.service.ts` (interface unifiée)
- [ ] PR Build : `apps/api/src/modules/observability/alerts.processor.ts` (consumer BullMQ)
- [ ] PR Build : `apps/api/src/modules/observability/discord-webhook.client.ts` (HTTP client + Zod payload)
- [ ] PR Build : `apps/api/src/modules/admin/observability/silence.controller.ts` (`POST /admin/observability/silence`)
- [ ] Migration Prisma additive (si nécessaire) : table `AlertSilence` ou stockage Redis (préférable, TTL natif)
- [ ] Mise à jour `CLAUDE.md` : ajouter section alerting + lien ADR-017
- [ ] Documentation `docs/ops/alerting-playbook.md` (Build) — quoi faire à la réception de chaque alerte type

---

## 6. Références

- Discord Webhooks : https://discord.com/developers/docs/resources/webhook
- Slack Incoming Webhooks (alternative) : https://api.slack.com/messaging/webhooks
- Sentry alert rules : https://docs.sentry.io/product/alerts/
- Grafana alerting (futur si Prometheus alert rules) : https://grafana.com/docs/grafana/latest/alerting/
- ADRs liées : ADR-014 (Observability stack), ADR-015 (BullMQ obs), ADR-016 (Logging)

---

*ADR-017 v1.0 — méthode [BMAD-light](../method/BMAD.md). À passer `Accepted` après sign-off CTO Design.*
