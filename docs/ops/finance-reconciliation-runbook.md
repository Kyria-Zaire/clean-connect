# Finance Reconciliation Runbook — Clean Connect Ops

> Procédures opérationnelles pour investiguer et résoudre les alertes financières émises par le monitoring PRD-004 Ticket 4.5.
> Couvre les alertes `finance_*` (cf. ADR-018 §2.7).
> Version Design — 2026-05-12. Mise à jour à valider après livraison Build Ticket 4.5.

## Règles d'or — à lire absolument

> Ces 5 règles s'appliquent **sans exception** à toute action de réconciliation manuelle.

1. **Stripe = vérité externe.** Sur tout désaccord montant/statut, **Stripe a raison**. Ne modifiez **jamais** un row côté Stripe pour "matcher" la DB. Mettez à jour la DB pour matcher Stripe.
2. **DB = vérité métier.** Statut mission, séquestre, commission snapshot restent pilotés par la DB. Ne modifiez **jamais** ces champs côté Stripe directement.
3. **Pas de fix DB silencieux.** Toute mutation `Payment / Transfer / Refund` passe par un endpoint admin **dédié** (audit `MissionEvent` automatique). Jamais `psql UPDATE` direct en prod.
4. **Confirmation `reason` obligatoire.** Tout `markResolved` / `markIgnored` doit être assorti d'une `reason ≥ 16 chars` (auditable). Une note sec/finance lit ce champ.
5. **Si vous doutez : escalez.** Mieux vaut une alerte qui dort 4 h en `INVESTIGATING` qu'un fix aveugle qui casse le compteur comptable. CTO/DPO valident en cas d'ambiguïté.

---

## Légende sévérité (rappel)

| Sévérité | Sens | Délai réaction | Channel |
|---|---|---|---|
| **P0** | Impact direct utilisateur (paiement bloqué) | < 30 min, 24/7 | `#ops-critical` |
| **P1** | Risque financier (mismatch, stuck funds, invariant) | < 4 h ouvré | `#ops-finance` + `#ops-alerts` |
| **P2** | Surveillance proactive | jour ouvré suivant | `#ops-finance` (batch) |

---

## Comment lire un mismatch — flux standard

```
Alerte Discord [P1][finance_mismatch]
        │
        ▼
1. Ouvrir /admin/finance/mismatches/:id
2. Lire dbSnapshot + stripeSnapshot (colonnes whitelistées)
3. Identifier mismatchType :
   ├── STATUS         → §1 — divergence statut Stripe ↔ DB
   ├── AMOUNT         → §2 — divergence montant
   ├── CURRENCY       → §3 — divergence devise (très rare, ne devrait pas arriver MVP EUR-only)
   ├── MISSING_DB     → §4 — opération Stripe sans counterpart DB (admin Stripe Dashboard probable)
   ├── MISSING_STRIPE → §5 — row DB sans counterpart Stripe (bug grave — ne devrait pas arriver)
   ├── INVARIANT_SUM  → §6 — trou comptable J-1
   ├── STUCK_*        → §7 — fonds bloqués (3 sous-cas)
   └── PAYOUT_ANOMALY → §8 — payout > 2× moyenne (review anti-fraude)
4. Décider : resolve, investigate, ignore (avec reason ≥ 16 chars)
5. Si action correctrice DB requise → §9 procédures admin
6. Documenter dans la note `resolutionNote`
```

---

## 1. Mismatch STATUS — divergence statut Stripe ↔ DB

**Cas typique** : Stripe dit `succeeded` (Transfer SENT) ; DB dit `PENDING`. Le webhook s'est perdu malgré le retry 4.2.

### Comment vérifier côté Stripe

```bash
# Récupérer le statut Stripe du transfer (ou paymentintent / refund selon resourceKind)
curl -X GET "https://api.stripe.com/v1/transfers/{stripeId}" \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2025-02-24.acacia"

# Lire les fields {id, amount, currency, destination, transfer_group, metadata.mission_id, created}
```

Si Stripe confirme un statut différent → la DB doit être réalignée.

### Comment vérifier côté DB

```sql
-- Recherche par stripeId
SELECT id, status, amount_cents, currency, created_at, updated_at
FROM transfers WHERE stripe_transfer_id = 'tr_xxx';

-- OU par paymentId (FK unique)
SELECT t.* FROM transfers t
JOIN payments p ON t.payment_id = p.id
WHERE p.id = 'uuid-xxx';
```

### Décision

| Scénario | Action |
|---|---|
| Stripe SENT + DB PENDING | Réconciliation OutboundTransferService — endpoint `POST /v1/admin/transfers/:id/reconcile` (utilise `reconcileTransferRow`) |
| Stripe FAILED + DB SENT | **Très rare** — escalade CTO. La DB indique qu'on a notifié le prestataire d'un succès qui n'a pas eu lieu. |
| Stripe REFUNDED + DB CAPTURED | Le refund a été créé côté Stripe Dashboard hors-app → §4 (MISSING_DB) |
| Stripe CANCELED + DB AUTHORIZED | L'autorisation a expiré ou été annulée → marquer DB `CANCELLED` via admin endpoint |

### Quoi ne JAMAIS faire automatiquement

- ❌ `UPDATE transfers SET status='SENT' WHERE id=...` direct en DB.
- ❌ Lancer `stripe.transfers.create` pour "compléter" un transfer manquant côté DB.
- ❌ Marquer `RESOLVED` sans avoir vérifié Stripe.

---

## 2. Mismatch AMOUNT — divergence montant

**Cas typique** : `Stripe.Transfer.amount = 12340` mais `DB.Transfer.amountCents = 12300`. Bug calcul ou mise à jour partielle.

### Investigation

1. **Calcul commission attendu** : `expected = Payment.amountAuthorizedCents - Payment.applicationFeeCents`.
2. Comparer `expected` vs `DB.Transfer.amountCents` vs `Stripe.Transfer.amount`.
3. Trois cas :
   - `expected = Stripe ≠ DB` → bug d'écriture DB (PR récente fautive).
   - `expected = DB ≠ Stripe` → bug d'appel Stripe (idempotency key réutilisée avec un montant différent ? Stripe a refusé silencieusement).
   - `expected ≠ DB ≠ Stripe` → bug calcul commission upstream — escalade CTO.

### Décision

- Toujours **investigate** d'abord (jamais resolve directement).
- Si bug DB → patch admin endpoint `POST /v1/admin/transfers/:id/recompute-from-stripe`.
- Si bug Stripe → cas très rare, escalade Stripe support (utiliser le `request_id` dans les logs Stripe API).
- Si bug calcul commission → ouverture ticket Linear `bug-commission-snapshot` + rollback PR fautive.

### Quoi ne JAMAIS faire

- ❌ Modifier `Payment.providerPayoutCents` à postériori. Ce snapshot est IMMUTABLE par design (PRD-003 ADR-008).
- ❌ Rembourser silencieusement la différence — passe par un refund tracé.

---

## 3. Mismatch CURRENCY — divergence devise

**Cas** : ne devrait pas arriver en MVP (EUR-only). Si détecté → escalade **immédiate** CTO (P0 effectif même si l'alerte sortie est P1).

---

## 4. Mismatch MISSING_DB — opération Stripe sans counterpart DB

**Cas typique** : un admin a remboursé un client depuis le Stripe Dashboard. Le refund existe côté Stripe (`re_xxx`) mais aucun `Refund` DB n'est lié au `Payment`.

### Investigation

1. Récupérer le `stripeId` dans `FinanceMismatch.stripeId`.
2. Stripe : `curl -X GET "https://api.stripe.com/v1/refunds/{stripeId}" -u "$STRIPE_SECRET_KEY:"` — lire `metadata` pour retrouver le `payment_intent` source.
3. Trouver le `Payment` DB associé via `stripePaymentIntentId`.
4. Identifier l'admin qui a effectué l'opération côté Stripe Dashboard (`Created by` dans l'audit Stripe Dashboard).

### Action

- Importer la trace DB via endpoint dédié `POST /v1/admin/refunds/import-from-stripe` (à livrer Ticket 4.5 Build ou TODO debt Ticket 4.3).
- Si endpoint non-livré au moment de l'incident → escalade CTO pour scripter une migration ad-hoc avec audit `MissionEvent`.

### Quoi ne JAMAIS faire

- ❌ Créer un row `Refund` manuellement en DB sans audit `MissionEvent`.
- ❌ Ignorer l'incident sans `resolutionNote` — perte de traçabilité comptable.

---

## 5. Mismatch MISSING_STRIPE — row DB sans counterpart Stripe

**Cas typique** : la DB contient un `Transfer.status = SENT` mais Stripe ne retrouve pas le `stripeTransferId`. Très grave — indique un bug ou une corruption.

### Action

1. **Vérifier 3 fois** que le `stripeTransferId` DB est correct (typo, troncation, environnement test/live mélangés).
2. Si confirmé MISSING côté Stripe → **escalade P0** au CTO. Possible :
   - bug DB historique (un test recette qui aurait écrit en prod ?),
   - intrusion / corruption data (`AdminAction` à rechercher),
   - bug serveur de migration.
3. Ne **JAMAIS** marquer `RESOLVED` sans intervention CTO + audit.

---

## 6. Mismatch INVARIANT_SUM — trou comptable J-1

**Cas** : `SUM(capture J-1) - SUM(transfer SENT J-1) - SUM(refund J-1) - SUM(commission J-1) ≠ 0` (tolérance 1 cent).

### Investigation

1. Bloquer la génération du `FinanceDailyReport` J-1 (status = `FAILED`).
2. Identifier la fenêtre exacte du décalage : J-1 00:00 → 23:59 Europe/Paris.
3. Requêtes SQL :
   ```sql
   -- Sommes par catégorie J-1
   SELECT SUM(amount_captured_cents) AS capture FROM payments WHERE status='CAPTURED' AND DATE(updated_at AT TIME ZONE 'Europe/Paris') = CURRENT_DATE - INTERVAL '1 day';
   SELECT SUM(amount_cents) AS transfer FROM transfers WHERE status='SENT' AND DATE(updated_at AT TIME ZONE 'Europe/Paris') = CURRENT_DATE - INTERVAL '1 day';
   SELECT SUM(amount_cents) AS refund FROM refunds WHERE status='REFUNDED' AND DATE(updated_at AT TIME ZONE 'Europe/Paris') = CURRENT_DATE - INTERVAL '1 day';
   SELECT SUM(application_fee_cents) AS commission FROM payments WHERE status='CAPTURED' AND DATE(updated_at AT TIME ZONE 'Europe/Paris') = CURRENT_DATE - INTERVAL '1 day';
   ```
4. Vérifier : `capture - transfer - refund - commission`.
5. Si delta > 0 (plateforme a "trop encaissé") → identifier les rows manquantes (transfer en retard, refund en cours).
6. Si delta < 0 (plateforme a "trop dépensé") → **escalade P0** CTO. Possible :
   - bug commission (transfer > providerPayoutCents),
   - double transfer (cas Verify PRD-003),
   - corruption.

### Décision

- **Toujours `INVESTIGATING`** d'abord, jamais `RESOLVED` direct.
- Une fois la cause identifiée + correction faite (manuel admin ou patch code) → `markResolved` avec `resolutionNote` détaillée.

---

## 7. Stuck funds — 3 sous-cas

### 7.1 `finance_stuck_authorization` (P1) — `Payment.AUTHORIZED > 5 j`

Autorisation Visa/MC expire ~7 j. À J+5, il reste 24 h pour capturer.

**Action** :
1. Vérifier `Mission.status` :
   - `CLIENT_VALIDATION_PENDING` → forcer auto-release manuellement via `POST /v1/admin/missions/:id/force-auto-release` (existant).
   - `DISPUTE_OPEN` → cas légitime, laisser ; le fix dispute libérera ou refund.
   - autres → escalade investigation (mission "perdue" en état orphelin).
2. Si pas de validation client possible → lancer un refund volontaire admin (`POST /v1/admin/payments/:id/refund`).
3. Documenter la décision dans `resolutionNote`.

**Quoi ne JAMAIS faire** : capturer aveuglément un `AUTHORIZED` > 5 j sans vérifier que la mission est complétée. Risque de retrait abusif → litige client.

### 7.2 `finance_stuck_captured_funds` (P1) — `Payment.CAPTURED > 24 h sans Transfer terminal`

L'argent est sur la plateforme mais le prestataire n'a pas été payé.

**Action** :
1. Lister les `Transfer` du `Payment` : `SELECT * FROM transfers WHERE payment_id = 'uuid-xxx';`
2. Si **aucun** Transfer → cas anormal (bug 4.2 ?). Investigation : vérifier `Mission.status` (DISPUTE_OPEN ? prestataire READY ?), retry transfer manuel admin via `POST /v1/admin/transfers/recreate-from-payment/:paymentId` (à livrer Build 4.5 ou TODO debt).
3. Si `Transfer.FAILED` → suivre playbook Ticket 4.2 §1 (transfer bloqué).
4. Si `Transfer.RETRY_SCHEDULED` → vérifier que le job BullMQ est encore programmé via BullBoard `/api/internal/queues`.

### 7.3 `finance_transfer_pending` (P2) — `Transfer.PENDING > 2 h`

Indicateur de surveillance — pas une urgence.

**Action** :
1. Vérifier que le job BullMQ correspondant existe via BullBoard.
2. Si oui → laisser le retry 4.2 faire son travail.
3. Si non → re-enqueue manuel admin via `POST /v1/admin/transfers/:id/retry` (existant).

---

## 8. Payout anomaly (P2) — `Transfer > 2× moyenne 30 j prestataire`

Le scheduler `FinancePayoutAnomalyScheduler` flag les transfers anormalement élevés.

### Investigation

1. Lire le `FinanceMismatch.metadata.factor` (ratio observé).
2. Lire l'historique 30 j du prestataire (`/admin/users/:prestataireId/transfers`).
3. Cas légitimes :
   - mission exceptionnelle (grand chantier, ménage post-construction) → confirmer côté client (chat support).
   - prestataire revient après pause → moyenne basse fausse.
4. Cas suspects :
   - facturation client surévaluée (bug calcul) → vérifier la mission source.
   - prestataire test/staging en prod (?!) → vérifier `User.role` + audit `MissionEvent` historique.
   - tentative de fraude (compromission compte client) → freezer compte + escalade CTO.

### Action

- Cas légitime → `markIgnored` avec `resolutionNote` = "Confirmé légitime, mission XXXX (grand chantier)".
- Cas suspect → `markInvestigating` + escalade CTO/sécurité.

**Quoi ne JAMAIS faire** : annuler le transfer post-hoc sans communication client/prestataire.

---

## 9. Procédures admin de correction

> Toutes les actions correctrices passent par des endpoints `/v1/admin/finance/*` ou `/v1/admin/transfers/*` ou `/v1/admin/refunds/*` (RBAC `ADMIN` + audit `MissionEvent`).

### 9.1 Réaligner DB sur Stripe (statut)

```http
POST /v1/admin/transfers/:id/reconcile
Authorization: Bearer <admin-jwt>
Idempotency-Key: <uuid v4>
{ "reason": "mismatch detected by finance reconcile run RUN-ID" }
```

Effet : appelle `OutboundTransferService.reconcileTransferRow(id)` qui fait `stripe.transfers.retrieve` + applique le statut côté DB.

### 9.2 Marquer un mismatch résolu

```http
PATCH /v1/admin/finance/mismatches/:id/resolve
Authorization: Bearer <admin-jwt>
{
  "reason": "Vérifié côté Stripe + DB, réalignement effectué via reconcile endpoint. Cause : webhook perdu pendant maintenance Stripe 2026-05-10."
}
```

`reason` minimum 16 chars (validation Zod).

### 9.3 Marquer un mismatch ignoré (faux positif documenté)

```http
PATCH /v1/admin/finance/mismatches/:id/ignore
Authorization: Bearer <admin-jwt>
{
  "reason": "Faux positif — règle d'arrondi multi-currency, delta 1 cent acceptable. Suivi : ouvrir ADR-XXX pour tolérance configurable."
}
```

### 9.4 Lancer un run reconcile manuel

```http
POST /v1/admin/finance/runs/manual
Authorization: Bearer <admin-jwt>
{
  "type": "RECONCILE",
  "windowDays": 1,
  "reason": "Investigation incident XXX du 2026-05-10."
}
```

Rate-limit : 1 run/heure (RBAC ADMIN). Crée un `FinanceReconciliationRun` taggé `triggeredBy = <adminUserId>`.

---

## 10. Procédure stuck funds (synthèse cross-cas)

```
                  ┌──────────────────┐
                  │  Stuck funds     │
                  │  alert reçue     │
                  └────────┬─────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         AUTHORIZATION   CAPTURED      PENDING
         > 5 j (P1)      > 24 h (P1)   > 2 h (P2)
              │            │            │
              ▼            ▼            ▼
        §7.1 ci-dessus  §7.2          §7.3
        force auto-rel  reconcile     check BullMQ
        OR refund       transfer      manual retry
```

Critère commun de décision : **identifier la cause** avant d'agir. Un fix sans cause = mismatch reproductible.

---

## 11. Indicateurs Grafana à surveiller en routine

| Dashboard (à créer Build Ticket 4.5) | Panel | Seuil d'attention |
|---|---|---|
| `cc-finance` | mismatches open (gauge `cleanconnect_finance_mismatches_open_count`) | > 5 P1 → triage |
| `cc-finance` | stuck funds amount (gauge `cleanconnect_finance_stuck_funds_amount_cents`) | > 100 € → investigation |
| `cc-finance` | reconciliation runs (counter `cleanconnect_finance_reconciliation_runs_total{status=FAILED}`) | > 0 → vérifier cron |
| `cc-finance` | invariant balance (gauge `cleanconnect_finance_invariant_balance_cents`) | toute valeur ≠ 0 → P1 immédiat |

---

## 12. Escalade

| Cas | Escalade |
|---|---|
| `INVARIANT_SUM` non résolu en 4 h | CTO + DPO + `#ops-critical` |
| `MISSING_STRIPE` (DB sans counterpart Stripe) | CTO immédiatement |
| Anomalie payout suspecte fraude | CTO + sécurité + freeze compte source |
| Reconcile cron `FAILED` 3 runs consécutifs | CTO + investigation infra (Stripe API down ? Redis ?) |
| Mismatch volume > 10 P1/jour pendant 3 jours | Ouvrir ticket Linear `ops-finance-incident-*` + revue mensuelle |

---

## 13. Hygiène ops finance

- **Hebdo** : revue collective des `FinanceMismatch.status = OPEN/INVESTIGATING` avec finance.
- **Mensuel** : audit `FinanceDailyReport` 30 j — vérifier la consistance globale (invariantBalanceCents = 0 systématique).
- **Trimestriel** : rotation des secrets `STRIPE_SECRET_KEY` + DPA Stripe revue.
- **Annuel** : audit comptable externe — fournir `FinanceDailyReport` 12 mois en CSV (export Ticket 4.5 — OQ-14 à trancher).

---

*Mainteneur : équipe Ops + Finance Clean Connect — questions @ ops@cleanconnect.fr / finance@cleanconnect.fr*

*Version Design Ticket 4.5 — 2026-05-12. Mise à jour Build après livraison des endpoints admin.*
