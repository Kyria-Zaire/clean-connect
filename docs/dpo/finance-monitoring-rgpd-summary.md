# Package DPO — Monitoring financier Clean Connect (PRD-004 §4.15)

> **Audience** : Délégué·e à la Protection des Données (DPO).
> **Objet** : recueillir le sign-off DPO avant activation `FF_FINANCE_MONITORING_ENABLED=true` en production.
> **Auteur** : reviewer-securite-code + ingénieur — 2026-05-13.

## 1. TL;DR

Le module **Monitoring financier** (PRD-004 Ticket 4.5) compare en lecture seule les sources Stripe (vérité externe) et la DB Clean Connect (vérité métier) pour détecter des écarts de paiement / transfert / remboursement. Il **ne traite aucune donnée personnelle directement identifiante** : les snapshots persistés sont **whitelistés** par `FINANCE_SNAPSHOT_WHITELIST` (champs numériques + identifiants techniques tronqués), aucune métrique Prometheus ne contient de label PII, aucun email/alerte Discord ne diffuse de donnée nominative.

| Question DPO clé | Réponse |
|---|---|
| Le module collecte-t-il de nouvelles données personnelles ? | **Non.** Réutilisation des données déjà collectées par PRD-001 (auth) / PRD-003 (paiements) — pas d'élargissement de finalité. |
| Quelles données personnelles sont **techniquement accessibles** au module ? | `User.id` (UUID v4), `User.role`, `Mission.id` — uniquement pour résolution audit `MissionEvent`. Aucun email/nom/téléphone/adresse lu par les schedulers. |
| Quelles données **persistent** dans les nouvelles tables ? | Cf. §3 (whitelists statiques figées par code). Aucun champ libre, aucun PII direct. |
| Combien de temps conservées ? | Cf. §4 — bornées par cron de purge automatique. |
| Y a-t-il des transferts hors UE ? | **Resend** (US — Adequacy Decision via DPF). Cf. §6. |
| Le module impacte-t-il les droits RGPD existants (export / rectification / effacement) ? | **Non** — `GET/PATCH/DELETE /users/me` continuent de fonctionner identiquement. Cf. §7. |
| Risque résiduel | Mineur. Détaillé §8. |

---

## 2. Description fonctionnelle

Le monitoring exécute **6 schedulers** automatiques + **5 endpoints admin** :

| Scheduler | Fréquence (Europe/Paris) | Finalité |
|---|---|---|
| `reconcile` | 03:30 quotidien | Compare PaymentIntent / Transfer / Refund DB ↔ Stripe sur 7 j |
| `stuck-funds` | `HH:05` horaire | Détecte `Payment.AUTHORIZED > 5j` ou `CAPTURED sans Transfer > 24h` |
| `invariants` | 04:15 quotidien | Vérifie 11 invariants déterministes (FIN-I-001…011 + FIN-J-001) |
| `payout-anomaly` | 04:45 quotidien | Détecte payouts anormaux (facteur configurable) |
| `daily-report` | 07:00 quotidien | Génère un rapport J-1 (agrégats numériques) + envoi email Resend |
| `retention` | 02:30 quotidien | Purge automatique selon durées légales |

| Endpoint admin (ADMIN uniquement) | Fonction |
|---|---|
| `GET /v1/admin/finance/mismatches` | Lister mismatches |
| `GET /v1/admin/finance/mismatches/:id` | Détail mismatch |
| `PATCH /v1/admin/finance/mismatches/:id` | Acknowledger / résoudre / ignorer (avec note ≥ 16 chars) |
| `POST /v1/admin/finance/runs/manual` | Déclencher un reconcile (rate-limit 1/h/admin atomique) |
| `GET /v1/admin/finance/daily-report/:date` | Lire un rapport J-1 |

**Toutes les opérations sont read-only côté Stripe.** Aucune mutation (`create/update/capture/refund/cancel`) n'est faite par le monitoring.

---

## 3. Données traitées — inventaire exhaustif

### 3.1 Tables nouvelles (PRD-004 Ticket 4.5)

#### `finance_reconciliation_runs` — 1 row par exécution scheduler

| Colonne | Type | PII ? | Justification |
|---|---|---|---|
| `id` | UUID v4 | non | Technique |
| `type` | enum (5 valeurs) | non | Discriminant scheduler |
| `status` | enum (3 valeurs) | non | RUNNING/COMPLETED/FAILED |
| `window_from` / `window_to` | timestamp | non | Bornes temporelles |
| `started_at` / `completed_at` | timestamp | non | Métadonnées exécution |
| `duration_ms` | int | non | Performance |
| `resources_scanned` / `mismatches_found` / `alerts_emitted` | int | non | Compteurs |
| `failure_message` | text | non | Message sanitizé via `redactSecretsInString` (jamais d'email/Bearer/clé Stripe) |
| `triggered_by_user_id` | UUID v4 nullable | **technique** | `User.id` de l'admin déclencheur ou `null` (cron). Pas d'email, pas de nom. Audit trail. |

#### `finance_mismatches` — 1 row par écart détecté

| Colonne | Type | PII ? | Justification |
|---|---|---|---|
| `id`, `run_id`, `mismatch_code`, `type`, `severity` | enum / UUID | non | Technique |
| `resource_kind` | enum (PAYMENT/TRANSFER/REFUND) | non | Discriminant |
| `resource_id` | UUID v4 | **technique** | `Payment.id` / `Transfer.id` / `Refund.id` — pas l'`id` du user |
| `amount_delta_cents` | int | non | Écart financier |
| `db_snapshot` | jsonb | **filtré** | Whitelist `FINANCE_SNAPSHOT_WHITELIST` ci-dessous — aucun PII |
| `stripe_snapshot` | jsonb | **filtré** | Idem — `stripe*Id` tronqués (24 chars) |
| `detected_at`, `acknowledged_at`, `resolved_at` | timestamp | non | Cycle de vie |
| `acknowledged_by_user_id`, `resolved_by_user_id` | UUID v4 nullable | **technique** | Audit admin — pas d'email |
| `resolution_notes` | text | **libre** | Saisie admin. Filtré par `deepSanitize` au log. Audit interne. |

**Whitelist `db_snapshot` (figée dans `finance.constants.ts:FINANCE_SNAPSHOT_WHITELIST`)** :

- `PAYMENT` : `id, status, amountAuthorizedCents, amountCapturedCents, currency, applicationFeeCents, providerPayoutCents, failureCode, createdAt, updatedAt, stripePaymentIntentIdTruncated`
- `TRANSFER` : `id, status, amountCents, currency, retryCount, failureCode, createdAt, updatedAt, stripeTransferIdTruncated`
- `REFUND` : `id, status, amountCents, currency, failureCode, initiatedBy, createdAt, settledAt, stripeRefundIdTruncated`
- `INVARIANT` : `invariant, leftCents, rightCents, deltaCents, reportDate`

**Aucun champ `email`, `phone`, `name`, `address`, `zip_code`, `birthdate`, `iban`, `bic`, `card_*`, `cvv` n'apparaît dans cette whitelist.** Les `stripe*Id` sont **tronqués à 24 caractères** (`FINANCE_STRIPE_ID_TRUNCATE_LENGTH`) — suffisant pour drill-down ops, insuffisant pour reconstruire l'ID exact.

#### `finance_daily_reports` — 1 row par jour J-1

| Colonne | Type | PII ? |
|---|---|---|
| `id`, `report_date`, `window_*` | UUID / dates | non |
| `captured_cents`, `transfer_sent_cents`, `refunded_cents`, `commission_cents`, `invariant_balance_cents` | int (cents) | non — **agrégats** |
| `captured_count`, `transfer_sent_count`, `refunded_count`, `open_mismatch_count` | int | non |
| `snapshot` | jsonb | non — payload `finance.daily_report.v1` (agrégats only) |
| `generated_at` | timestamp | non |

#### `finance_alerts` — 1 row par alerte émise (audit cooldown)

| Colonne | Type | PII ? |
|---|---|---|
| `id`, `kind`, `severity`, `mismatch_id`, `run_id` | UUID / enum | non |
| `context` | jsonb | **filtré** par `deepSanitize` (clés sensibles → `[REDACTED]`) |
| `created_at` | timestamp | non |

### 3.2 Tables modifiées

**Aucune** colonne PII ajoutée aux tables existantes (`users`, `missions`, `payments`, `transfers`, `refunds`, `stripe_webhook_events`).

### 3.3 Logs Pino structurés

Tous les loggers finance émettent uniquement :

- `runId`, `mismatchId`, `paymentId` *(UUID v4 technique)*
- compteurs numériques (`scanned`, `mismatches`, `alerts`, `durationMs`)
- enum statuts / kinds / sévérités
- IDs Stripe **tronqués** (12-24 chars max)

**Redactor Pino** (`apps/api/src/common/logger/redactor.ts`) actif au boot — pattern `Bearer`, `sk_(test|live)_*`, `whsec_*`, `eyJ*` (JWT) automatiquement masqués.

### 3.4 Métriques Prometheus

| Métrique | Labels | PII ? |
|---|---|---|
| `cleanconnect_finance_reconciliation_runs_total` | `{type, status}` | non |
| `cleanconnect_finance_reconciliation_duration_seconds` | `{type}` | non |
| `cleanconnect_finance_mismatches_total` | `{type, severity}` | non |
| `cleanconnect_finance_mismatches_open_count` | `{severity}` | non |
| `cleanconnect_finance_stuck_funds_total` | `{kind}` | non |
| `cleanconnect_finance_stuck_funds_amount_cents` | `{kind}` | non |
| `cleanconnect_finance_refund_mismatch_total` | `{kind}` | non |
| `cleanconnect_finance_invariant_break_total` | `{invariant}` | non |
| `cleanconnect_finance_invariant_balance_cents` | `{report_date_offset}` | non |
| `cleanconnect_finance_daily_report_generated_total` | `{status}` | non |
| `cleanconnect_finance_payout_anomaly_factor` | `{}` | non |
| `cleanconnect_finance_transfer_pending_total` | `{}` | non |

**Tous les labels sont whitelistés** (`FINANCE_METRIC_LABELS` `Object.freeze`) — vérification compile-time (TS) + runtime (`assertLabel`). Cardinalité totale ≤ 80 séries.

**Aucun label** `userId`, `missionId`, `paymentId`, `transferId`, `refundId`, `email`, `phone`, `stripeId` non tronqué.

### 3.5 Emails Resend (daily report)

Payload **uniquement agrégats numériques** :

```
Daily finance report — 2026-05-12
Balance J-1 : -12 cents (sain=false)
Captured : 348200 cents
Transfers SENT : 285200 cents
Refunds : 0 cents
Commission : 62700 cents
Open mismatches : P1=1 P2=3
```

**Destinataire** : `FINANCE_DAILY_REPORT_EMAIL_TO` configurable (ops finance interne). **Aucun email client/prestataire** envoyé.

### 3.6 Alertes Discord

`FinanceAlertingService.emit` ne diffuse vers Discord **que** le `context` jsonb après **2 niveaux** de sanitization :

1. Caller doit utiliser `sanitizeForFinanceSnapshot` (whitelist explicite)
2. `FinanceAlertingService` re-applique `deepSanitize` (clés sensibles → `[REDACTED]`)

Le payload Discord type :

```json
{
  "kind": "finance_mismatch",
  "severity": "P1",
  "context": {
    "mismatchType": "AMOUNT",
    "resourceKind": "TRANSFER",
    "resourceIdTruncated": "110ef913...3827",
    "amountDeltaCents": 100
  }
}
```

---

## 4. Rétention & purge automatique

| Table | Durée de rétention | Pilotage | Justification |
|---|---|---|---|
| `finance_mismatches` `RESOLVED` / `IGNORED` | 90 j depuis `resolved_at` | env `FINANCE_MISMATCH_RETENTION_DAYS` (default 90) | Minimisation RGPD ; audit ops < 90 j |
| `finance_mismatches` `OPEN` / `INVESTIGATING` | 90 j depuis `detected_at` (pas de rétention indéfinie) | idem | Décision Build CTO OQ-12 — un mismatch qui dort 90 j est considéré classé sans suite |
| `finance_daily_reports` | **5 ans** (1825 j) | env `FINANCE_DAILY_REPORT_RETENTION_DAYS` (default 1825) | Pièce comptable agrégée (cf. note §4.1) — **à confirmer DPO** |
| `finance_alerts` | 30 j | env `FINANCE_ALERT_RETENTION_DAYS` (default 30) | Audit cooldown post-mortem suffisant |
| `finance_reconciliation_runs` `COMPLETED` | 90 j depuis `completed_at` | hard-coded `FinanceRetentionService` | Audit exécutions schedulers |
| `finance_reconciliation_runs` `FAILED` | indéfinie (conservé) | hard-coded | Décision Build CTO OQ-12 — investigation post-mortem |

**Purge** : tâche cron `FinanceRetentionScheduler` exécutée tous les jours à 02:30 Europe/Paris. Idempotente, gated par FF, lock anti-overlap, log `finance.retention.done deletedMismatches=… deletedReports=… deletedAlerts=… deletedRuns=…`.

### 4.1 Note rétention `finance_daily_reports`

Le défaut **5 ans** vise à couvrir l'usage *audit comptable interne agrégé*. **Si le DPO juge cette durée excessive** (les agrégats ne sont pas des pièces comptables officielles au sens du Code de commerce art. L123-22 — qui imposerait 10 ans pour factures), elle peut être ramenée à **2 ans** ou **1 an** sans impact fonctionnel via la variable d'env `FINANCE_DAILY_REPORT_RETENTION_DAYS` (Zod min 30 / max 3650).

**Recommandation engineering** : 1825 j (5 ans) par défaut. **Décision finale = DPO.**

---

## 5. Droits RGPD — impact analysé

| Droit (RGPD chap. III) | Implémentation existante | Impact PRD-004 §4.15 |
|---|---|---|
| Accès — art. 15 | `GET /users/me/export` (PRD-001) | **Aucun changement.** Aucune donnée nouvelle stockée sur l'utilisateur — donc rien à ajouter à l'export. Les snapshots finance contiennent uniquement des `User.id` (technique, déjà exporté). |
| Rectification — art. 16 | `PATCH /users/me` | **Aucun changement.** |
| Effacement — art. 17 | `DELETE /users/me` (soft delete + purge 30 j) | **Conservé.** À la purge complète, les rows `finance_mismatches.acknowledged_by_user_id` / `resolved_by_user_id` / `finance_reconciliation_runs.triggered_by_user_id` deviennent **orphelines** (FK `User.id` supprimée). Décision engineering : conserver l'audit trail (FK `SetNull` côté Prisma) — ces colonnes ne sont **pas** des PII puisque l'identifiant est anonymisé une fois `User` purgé. **À confirmer DPO.** |
| Limitation — art. 18 | flag `users.deleted_at` | **Conservé.** |
| Portabilité — art. 20 | export JSON | **Aucun changement.** |
| Opposition — art. 21 | n/a (base légale = exécution contrat) | n/a |

---

## 6. Sous-traitants / transferts

| Service | Pays | Données échangées | Garanties |
|---|---|---|---|
| **Stripe** (existant PRD-003) | US (Ireland EU subsidiary pour SCA) | PaymentIntent ID, Transfer ID, Refund ID, montants — **lecture seule** | Stripe = DPF certified ; DPA en place |
| **Cloudinary** (existant PRD-003) | US | Aucune donnée finance échangée | n/a |
| **Resend** (NOUVEAU pour FIN-DAILY-EMAIL) | US | Email contenant agrégats numériques + 1 adresse destinataire interne ops | DPF certified — à vérifier DPO ; pas de PII utilisateur dans le corps |
| **Discord** (alerting — réutilisation) | US | Contexte alerte (whitelisté + sanitizé) | Tier 2 — pas de PII dans payload |
| **Grafana Cloud** (si utilisé) | EU | Métriques Prometheus | Auth bearer ; pas de PII en label |

**Action DPO recommandée** : ajouter **Resend** au registre des sous-traitants (article 28 RGPD). Pas de nouveau DPA si SendGrid/Postmark sont déjà couverts par un DPA générique « transactional email ».

---

## 7. Vérifications techniques DPO

Le DPO peut vérifier en **lecture directe** :

```sql
-- 7.1 Aucune colonne PII dans les snapshots
SELECT id, db_snapshot::text FROM finance_mismatches LIMIT 10;
-- Attendu : uniquement champs whitelistés (cf. §3.1)

-- 7.2 Aucun email dans les contextes d'alerte
SELECT id, context::text FROM finance_alerts
WHERE context::text LIKE '%@%' OR context::text LIKE '%email%';
-- Attendu : 0 rows

-- 7.3 Rétention effective (purge cron a tourné)
SELECT MIN(detected_at) AS oldest_mismatch FROM finance_mismatches;
SELECT MIN(generated_at) AS oldest_report FROM finance_daily_reports;
SELECT MIN(created_at) AS oldest_alert FROM finance_alerts;
-- Attendu : oldest_mismatch > NOW() - 90 days
--          oldest_report > NOW() - 1825 days
--          oldest_alert > NOW() - 30 days

-- 7.4 Aucun champ libre côté users orphelin lié à finance
SELECT u.id, u.deleted_at
FROM users u
WHERE u.deleted_at IS NOT NULL
  AND (EXISTS (SELECT 1 FROM finance_reconciliation_runs r WHERE r.triggered_by_user_id = u.id)
    OR EXISTS (SELECT 1 FROM finance_mismatches m WHERE m.acknowledged_by_user_id = u.id OR m.resolved_by_user_id = u.id));
-- À discuter DPO : faut-il SET NULL sur ces FK au DELETE ?
```

---

## 8. Risques résiduels & mitigations

| Risque | Sévérité | Mitigation |
|---|---|---|
| Fuite PII via `resolution_notes` (saisie libre admin) | Faible | `deepSanitize` au log + revue admin obligatoire ≥ 16 chars |
| Resend panne / fuite payload | Faible | Payload sans PII utilisateur ; alerte fallback P1 ; quota Resend monitoré |
| User supprimé laisse FK audit orpheline | Mineur | UUID v4 désormais anonyme (pas de jonction possible) ; à décider FK strategy avec DPO |
| Cardinalité Prometheus dérive | Faible | Whitelist `Object.freeze` + `assertLabel` runtime + tests unitaires |
| Daily report 5 ans = trop long | À arbitrer | Configurable `FINANCE_DAILY_REPORT_RETENTION_DAYS` |
| Webhook Stripe replay | Faible | HMAC + idempotence DB + tests concurrence verts |

---

## 9. Sign-off DPO demandé

> ☐ Le DPO confirme que :
>
> 1. Les nouvelles tables `finance_*` **ne collectent aucune nouvelle PII** au-delà des `User.id` techniques déjà couverts par PRD-001 ;
> 2. La rétention `finance_daily_reports` proposée à **5 ans** est ☐ acceptée / ☐ à réduire à `___` jours ;
> 3. La sous-traitance **Resend (US — DPF certified)** pour l'envoi du daily report est ☐ acceptée et ajoutée au registre article 28 ;
> 4. La stratégie FK `SetNull` au `DELETE /users/me` est ☐ acceptée / ☐ à modifier en `Restrict` (conservation audit) / ☐ à modifier en `Cascade` (effacement total) ;
> 5. Le module peut être activé en production sous `FF_FINANCE_MONITORING_ENABLED=true` après smoke recette validée.

| Décideur | Signature | Date |
|---|---|---|
| DPO | `@…` | `YYYY-MM-DD` |

---

## 10. Documents annexes

- **Code** : `apps/api/src/modules/finance/finance.constants.ts` (whitelists figées)
- **Code** : `apps/api/src/common/security/sanitize.ts` (deepSanitize + redactSecretsInString)
- **Rapport sécu Build** : `docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-build-verify.md`
- **Rapport sécu Verify final** : `docs/security-reviews/2026-05-13-prd-004-ticket-4-5-financial-monitoring-verify-final.md`
- **Runbook activation** : `docs/runbooks/finance-monitoring-activation.md`
- **PRD source de vérité** : `docs/prd/PRD-004-hardening-ops-compliance.md` §4.15
- **ADR-018** : décisions architecture monitoring finance

---

*Package DPO produit le 2026-05-13. À actualiser si la rétention ou un nouveau sous-traitant est ajouté.*
