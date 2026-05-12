# ADR-018 — Financial monitoring & reconciliation strategy

> **ADR** = *Architecture Decision Record*. Une décision = un fichier.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-018` |
| **Titre** | Stratégie de monitoring financier Clean Connect : Stripe = source externe, DB = source opérationnelle, réconciliation périodique read-only, **aucune correction destructive automatique au MVP** |
| **Statut** | `Proposed` (Design Ticket 4.5) |
| **Date** | 2026-05-13 |
| **Auteur** | `architecte-api` + `securite` (fintech-engineer) + `ops` |
| **PRD lié** | `docs/prd/PRD-004-hardening-ops-compliance.md` Ticket 4.5 |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-004-financial-monitoring-design-prereview.md` |

---

## 1. Contexte

Clean Connect manipule des flux financiers réels via Stripe Connect Express (cf. ADR-008) : autorisation → capture → transfer prestataire → refund éventuel. Trois sources de vérité cohabitent :

1. **Stripe** (externe, autoritative pour ce qui touche les fonds réellement débités/transférés/remboursés).
2. **DB Clean Connect** (interne, autoritative pour le statut métier de la mission, le snapshot commission, l'audit RBAC).
3. **Webhooks Stripe** (transport asynchrone entre les deux — peut perdre/désynchroniser des events sur partition réseau).

PRD-003 a livré la mécanique opérationnelle (ADR-008) ; PRD-004 Tickets 4.1 (observabilité) et 4.2 (retry & recovery BullMQ) ont fiabilisé la **plomberie** technique. Il reste un risque de **dérive financière silencieuse** :

- un webhook Stripe perdu malgré le retry BullMQ (poison après 5 attempts → DLQ → action admin requise mais pas garantie sous H+24),
- une opération admin (refund manuel, retry transfer) qui aboutit côté Stripe mais échoue à updater la DB,
- un `Transfer.PENDING` qui reste bloqué > 2 h sans réconciliation,
- un `Payment.REQUIRES_CAPTURE` qui dépasse 6 j (autorisation Visa/MC expire ~7 j → fonds perdus),
- un montant transféré ≠ `providerPayoutCents` (bug de calcul commission),
- un trou comptable entre `SUM(Payment.captured) - SUM(Transfer) - SUM(Refund) - SUM(Commission)`.

**Aucun de ces cas n'est observable depuis les métriques Tickets 4.1/4.2** (qui tracent les jobs, pas les invariants comptables). Il faut un mécanisme dédié de **réconciliation périodique** qui interroge Stripe directement et compare aux soldes DB.

---

## 2. Décision

### 2.1 Principes directeurs

| Principe | Énoncé |
|---|---|
| **P1 — Stripe = vérité externe** | Sur tout désaccord, **Stripe a raison** pour les montants/statuts réellement traités. La DB est ré-alignée par action admin tracée — **jamais** automatiquement au MVP. |
| **P2 — DB = vérité opérationnelle** | Statut métier (mission status, séquestre flag, commission snapshot) reste piloté par la DB. Stripe ne sait pas qu'une mission est `DISPUTE_OPEN`. |
| **P3 — Reconciliation = read-only** | Aucun job de reconciliation ne modifie de l'état métier ou Stripe au MVP. Il **détecte**, **persiste** un `FinanceMismatch`, **alerte** ; un humain admin décide. |
| **P4 — Cardinalité bornée** | Les métriques finance n'utilisent **jamais** d'ID (`paymentId`, `missionId`, `transferId`) en label. Aggregation par `type` / `severity` / `status` uniquement. |
| **P5 — Audit obligatoire** | Toute action admin de réconciliation (`reconcile`, `markResolved`, etc.) écrit un `MissionEvent` (ou `AdminAction` Ticket 4.3) avec `actorUserId` + `reason`. |
| **P6 — Pas d'automatisme destructif** | Aucun `prisma.update` automatique qui rend un trou comptable non-rejouable. Tout fix manuel passe par un endpoint admin avec confirmation 2-étapes. |
| **P7 — Quotas Stripe respectés** | Reconciliation `retrieve` rate-limitée à 25 req/s max (Stripe limit 100/s par account — on garde 75 % de marge pour le runtime). |

### 2.2 Architecture cible

```
                                  ┌────────────────────────────────┐
                                  │  Stripe API (Frankfurt)        │
                                  │  payment_intents / transfers / │
                                  │  refunds — retrieve only       │
                                  └────────────────┬───────────────┘
                                                   │ ≤ 25 req/s
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  FinanceReconcileService (NestJS @cron, idempotent par run-id)   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  1. Sélectionne les rows DB (Payment/Transfer/Refund)      │  │
│  │     créées ou modifiées sur fenêtre J-7 (configurable).    │  │
│  │  2. Pour chaque row → Stripe `retrieve` (p-limit 25).      │  │
│  │  3. Compare statut + amount + currency + idempotency key.  │  │
│  │  4. Si divergence → persist `FinanceMismatch` + alert P1.  │  │
│  │  5. Vérifie 11 invariants comptables sur fenêtre J-1.      │  │
│  │  6. Génère `FinanceDailyReport` snapshot.                  │  │
│  │  7. Émet métriques `cleanconnect_finance_*`.               │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────┬───────────────────────────────────────┬───────────┘
               │ alerts P1/P2                          │ snapshot
               ▼                                       ▼
   ┌───────────────────────┐               ┌────────────────────────┐
   │  AlertingService      │               │  /admin/finance/*      │
   │  Discord #ops-finance │               │  (Ticket 4.3 UI debt)  │
   └───────────────────────┘               └────────────────────────┘
```

### 2.3 Fréquence et fenêtres

| Job | Cadence | Fenêtre analysée | Quota Stripe approx. (J+0) |
|---|---|---|---|
| `FinanceReconcileScheduler` (reconciliation Stripe ↔ DB) | **Quotidien 03:30 Europe/Paris** | rows `Payment/Transfer/Refund` `updatedAt ≥ now - 7 j` | ~300 retrieves/jour MVP → < 1 % quota |
| `FinanceStuckFundsScheduler` (stuck funds detector) | **Horaire (top heure)** | invariants 6+9 (cf. §3) sur DB seule | 0 (DB only) |
| `FinanceInvariantsScheduler` (consistance comptable) | **Quotidien 04:15 Europe/Paris** | sommes J-1 (00:00 → 23:59 Europe/Paris) | 0 (DB only) |
| `FinanceDailyReportScheduler` (rapport agrégé) | **Quotidien 07:00 Europe/Paris** | snapshot consolidé J-1 (KPIs + mismatchs non résolus) | 0 (lit DB + rapports cron précédents) |

**Décalage entre cron** : 03:30 → 04:15 → 07:00 laisse au reconcile cron le temps de finir avant invariants ; au report cron de récupérer les outputs des deux.

### 2.4 Persistance — option **A retenue MVP** : modèle conceptuel + tables dédiées

> Discussion finale OQ-11 (cf. §6.3). Décision : **on persiste** les mismatches en DB (pas seulement en logs/metrics).
> Rationale : un mismatch peut rester plusieurs jours en investigation ; les logs Pino sont rotés à 30 j et non-requêtables. Les métriques Prometheus n'identifient pas la row source. Sans DB on perd la traçabilité d'investigation.

4 tables conceptuelles (migration Prisma à dérouler en **Build** Ticket 4.5, pas ici) :

```
FinanceReconciliationRun (1 row par exécution du cron)
  id               String   @id @default(uuid())
  type             FinanceRunType  // RECONCILE | STUCK | INVARIANTS | REPORT
  startedAt        DateTime
  finishedAt       DateTime?
  status           FinanceRunStatus // RUNNING | COMPLETED | FAILED
  scannedCount     Int
  mismatchCount    Int      @default(0)
  durationMs       Int?
  errorMessage     String?  @db.Text
  triggeredBy      String?  // 'cron' | adminUserId

FinanceMismatch (1 row par divergence détectée — N par run)
  id               String   @id @default(uuid())
  runId            String   @relation(FinanceReconciliationRun)
  type             FinanceMismatchType   // STATUS / AMOUNT / CURRENCY / MISSING_DB / MISSING_STRIPE / INVARIANT_SUM
  severity         AlertSeverity         // P1 (default) ou P2 (stuck pending)
  resourceKind     FinanceResourceKind   // PAYMENT | TRANSFER | REFUND | INVARIANT
  resourceId       String?  @db.Uuid     // DB id si applicable (NULL pour invariant)
  stripeId         String?  @db.VarChar(255)  // chiffrement application-side optionnel (cf. §4.2)
  dbSnapshot       Json     // snapshot DB row au moment de la détection (anonymisé — pas de PII)
  stripeSnapshot   Json     // snapshot Stripe retrieve (anonymisé — id + status + amount + currency seulement)
  description      String   @db.Text
  status           FinanceMismatchStatus // OPEN | INVESTIGATING | RESOLVED | IGNORED
  detectedAt       DateTime @default(now())
  resolvedAt       DateTime?
  resolvedBy       String?  @db.Uuid
  resolutionNote   String?  @db.Text

FinanceDailyReport (1 row par jour)
  id               String   @id @default(uuid())
  reportDate       Date     @unique          // J-1 Europe/Paris
  generatedAt      DateTime @default(now())
  paymentsCapturedCount   Int
  paymentsCapturedAmountCents Int
  transfersSentCount      Int
  transfersSentAmountCents Int
  refundsCount     Int
  refundsAmountCents Int
  commissionsAmountCents Int
  mismatchesOpenCount Int
  invariantBalanceCents Int  // SUM(capture) - SUM(transfer) - SUM(refund) - SUM(commission) — devrait être 0

FinanceAlert (1 row par alerte émise — facultatif si AlertingService.emit logs suffisent)
  id               String   @id @default(uuid())
  severity         AlertSeverity
  kind             String   @db.VarChar(64)   // 'finance_mismatch' | 'stuck_funds' | etc.
  context          Json     // pas de PII, FK courte vers FinanceMismatch.id si applicable
  emittedAt        DateTime @default(now())
  acknowledgedAt   DateTime?
  acknowledgedBy   String?  @db.Uuid

// Enums associés (à figer au Build) :
enum FinanceRunType { RECONCILE STUCK INVARIANTS REPORT }
enum FinanceRunStatus { RUNNING COMPLETED FAILED }
enum FinanceMismatchType { STATUS AMOUNT CURRENCY MISSING_DB MISSING_STRIPE INVARIANT_SUM STUCK_PENDING STUCK_REQUIRES_CAPTURE }
enum FinanceResourceKind { PAYMENT TRANSFER REFUND INVARIANT }
enum FinanceMismatchStatus { OPEN INVESTIGATING RESOLVED IGNORED }
```

**Rétention** : 90 j sur `FinanceMismatch` resolved/ignored ; rétention **indéfinie** sur les open (auditable). `FinanceDailyReport` conservé 5 ans (obligation comptable indirecte). Cron de purge déclenché Ticket 4.4 (RGPD).

### 2.5 Frontière avec Tickets 4.1 / 4.2

| Préoccupation | Ticket | Rôle |
|---|---|---|
| Job BullMQ stalled / DLQ technique | 4.1 + 4.2 | détecte la **mécanique** (job failed/poison) |
| Erreur Stripe transient → retry exponentiel | 4.2 | retry transfer automatique max 5 |
| **Dérive Stripe ↔ DB** | **4.5** | détecte le **résultat** (un transfer abouti côté Stripe mais oublié côté DB, ou inversement) |
| Trou comptable invariants | **4.5** | seul ticket habilité à le mesurer |
| Alerte P0 paiement bloqué | 4.2 (`bullmq_failed_jobs`) | **OK** — déjà couvert |
| Alerte P1 mismatch Stripe/DB | **4.5** (`finance_mismatch`) | nouveau |

Les deux tickets sont **complémentaires** : 4.2 garantit que la **plomberie** ne perd pas de jobs ; 4.5 garantit que les **flux financiers** restent cohérents même si la plomberie a hoqueté.

### 2.6 Pas de correction automatique au MVP (P3 + P6)

**Décision dure** : aucun job de reconciliation ne modifie de manière destructive le statut DB ou ne déclenche une opération Stripe au MVP.

Cas autorisés (read-only ou enrichissement non-destructif) :
- ✅ Lire `Payment` côté Stripe via `paymentIntents.retrieve` et comparer.
- ✅ Persister un `FinanceMismatch` dans la table dédiée.
- ✅ Émettre une alerte AlertingService.
- ✅ Réutiliser `OutboundTransferService.reconcileTransferRow` (existe déjà, met à jour `Transfer.status` à partir d'un retrieve Stripe — mais sur action admin uniquement, pas en cron auto).

Cas interdits MVP :
- ❌ Capturer automatiquement un `Payment.AUTHORIZED` > 6 j (proposition rejetée — risque énorme si un client a contesté entre-temps).
- ❌ Forcer un `Transfer.PENDING > 2 h` en `FAILED` sans vérifier Stripe (déjà couvert par retry 4.2, pas besoin de doublon).
- ❌ Rembourser automatiquement un `Payment.CAPTURED` orphelin sans `Transfer` (cas qui devrait être impossible — si détecté, alerte humaine).
- ❌ Marquer un mismatch en `RESOLVED` sans action humaine explicite.

Réévaluation T+90 j prod : si volume de mismatchs > 5/jour et patterns récurrents (ex. 80 % des cas = même fix admin), envisager une **automation conservatrice** documentée par ADR-019 dédiée. Pas avant.

### 2.7 Alerting routing finance

| Alerte | Sévérité | Channel Discord | Cooldown | TODO Ticket 4.3 |
|---|---|---|---|---|
| `finance_mismatch` (statut/montant/devise divergent Stripe↔DB) | **P1** | `#ops-finance` + `#ops-alerts` | 15 min/`kind` | drill-down `/admin/finance/mismatches/:id` |
| `finance_stuck_captured_funds` (`Payment.CAPTURED` > 24 h sans Transfer terminal) | **P1** | `#ops-finance` | 1 h/ressource | drill-down stuck payments |
| `finance_stuck_authorization` (`Payment.AUTHORIZED` > 5 j → 24 h avant expiration Visa/MC) | **P1** | `#ops-finance` | 4 h/ressource | drill-down stuck auth |
| `finance_transfer_pending` (`Transfer.PENDING` > 2 h) | **P2** | `#ops-finance` (batch) | 30 min | batch P2 standard |
| `finance_refund_mismatch` (Stripe Refund.amount ≠ DB Refund.amount) | **P1** | `#ops-finance` | 15 min/`kind` | drill-down refund detail |
| `finance_invariant_break` (`balance != 0`) | **P1** | `#ops-finance` + `#ops-critical` | 1 h/jour | drill-down daily report |
| `finance_reconcile_job_failed` (cron run = FAILED) | **P1** | `#ops-finance` | 30 min | retry manuel ; cron suivant prendra le relais |
| `finance_report_missing` (daily report non généré avant 08:00 Europe/Paris) | **P2** | `#ops-finance` | 1 day | retry job ou enquête |
| `finance_payout_anomaly` (transfer > 2× moyenne 30 j d'un prestataire) | **P2** | `#ops-finance` (batch) | 24 h/prestataire | review manuelle anti-fraude |

`AlertKind` enum à enrichir (Ticket 4.5 Build) : `finance_mismatch`, `finance_stuck_funds`, `finance_invariant_break`, `finance_reconcile_failed`, `finance_payout_anomaly`. Réutilise contractuellement `AlertingService.emit` (ADR-017) → cooldown + `sanitizeForAlert` automatique.

### 2.8 Cas particuliers métier

#### Cas A — `Mission.status = DISPUTE_OPEN` (séquestre verrouillé)

Le séquestre est volontairement bloqué par PRD-003 / ADR-008 quand un litige est ouvert. La reconciliation **doit ignorer** ces missions (le statut DB est intentionnellement décalé de Stripe).

→ Implémentation : `WHERE Mission.status != 'DISPUTE_OPEN'` sur toutes les queries reconcile.

#### Cas B — Transfer manuel admin Stripe Dashboard (hors-application)

Si un admin lance un transfer Stripe **depuis le dashboard Stripe** (pas via notre API) — cas exceptionnel mais possible —, le Transfer existe côté Stripe mais pas côté DB.

→ Détection : `FinanceMismatchType.MISSING_DB`. Alerte P1. Action admin : créer le Transfer DB associé via endpoint dédié (`POST /v1/admin/transfers/import-from-stripe` — TODO debt Ticket 4.5).

#### Cas C — Refund Stripe Dashboard

Idem cas B — un admin rembourse depuis Stripe (cas typique : litige Stripe / chargeback géré côté Stripe).

→ Détection : `FinanceMismatchType.MISSING_DB`. Alerte P1. Action admin : créer le Refund DB associé (`POST /v1/admin/refunds/import-from-stripe`).

#### Cas D — Payout différé Stripe (transfer pas encore "settled")

Stripe peut différer l'effective settlement d'un `Transfer` de quelques heures (anti-fraude). Pendant cet intervalle, `Transfer.status` côté API = `paid` mais le payout côté Stripe Dashboard prestataire = `pending`.

→ La DB Clean Connect ne stocke pas le payout settlement (hors scope). Pas de mismatch.

---

## 3. Invariants financiers à vérifier (11 invariants)

> Numérotés pour traçabilité dans la documentation Build (chaque invariant = test unit + run cron production).

| # | Invariant | Type | Détection si rompu |
|---|---|---|---|
| **I-1** | `Payment.status = CAPTURED ⇒ amountCapturedCents > 0` | Cohérence DB | log + `FinanceMismatchType.STATUS` |
| **I-2** | `Transfer.status = SENT ⇒ Payment.status = CAPTURED` | Cohérence inter-table | log + `FinanceMismatchType.STATUS` |
| **I-3** | `Transfer.amountCents = Payment.providerPayoutCents` (à la création) | Lock-in commission | `FinanceMismatchType.AMOUNT` (P1 critique) |
| **I-4** | `Refund.status = REFUNDED ⇒ Payment.status ∈ {CAPTURED, REFUNDED}` | Cohérence inter-table | `FinanceMismatchType.STATUS` |
| **I-5** | `Refund après Transfer.SENT ⇒ workflow manuel admin obligatoire` (initiatedBy != SYSTEM) | RBAC + audit | log + alerte P1 si automatique |
| **I-6** | `Stripe.PaymentIntent.amount_received = DB.Payment.amountCapturedCents` | Croisement externe | `FinanceMismatchType.AMOUNT` (P1) |
| **I-7** | `Stripe.Transfer.amount = DB.Transfer.amountCents` | Croisement externe | `FinanceMismatchType.AMOUNT` (P1) |
| **I-8** | `Stripe.Refund.amount = DB.Refund.amountCents` | Croisement externe | `FinanceMismatchType.AMOUNT` (P1) |
| **I-9** | `Payment.status = AUTHORIZED ∧ createdAt < now - 5 j` ⇒ alerte préventive | Stuck detection | `finance_stuck_authorization` (P1) |
| **I-10** | `Transfer.status = PENDING ∧ updatedAt < now - 2 h ∧ Mission.status != DISPUTE_OPEN` | Stuck detection | `finance_transfer_pending` (P2) |
| **I-11** | `Payment.status = CAPTURED ∧ Transfer.status ∉ {PENDING, SENT, FAILED} ∧ updatedAt > now - 1 h` (grace) | Stuck post-capture | `finance_stuck_captured_funds` (P1) après 24 h |

**Invariant J-1 (Daily report `invariantBalanceCents`)** :
```
SUM(Payment.amountCapturedCents WHERE capturedAt ∈ [J-1])
  - SUM(Transfer.amountCents WHERE status=SENT AND createdAt ∈ [J-1])
  - SUM(Refund.amountCents WHERE status=REFUNDED AND createdAt ∈ [J-1])
  - SUM(Payment.applicationFeeCents WHERE capturedAt ∈ [J-1])
  = 0 (tolérance 0,01 € soit 1 cent à cause de l'arrondi euros multi-currency, qui restera 0 en EUR-only MVP)
```

Si `≠ 0` → `finance_invariant_break` P1 + bloque la génération du report tant que non résolu (état `FAILED`).

---

## 4. Sécurité & RGPD

### 4.1 Pas de PII dans les snapshots

Les colonnes `FinanceMismatch.dbSnapshot` / `stripeSnapshot` (JSON) ne stockent **JAMAIS** :
- email, phone, firstName/lastName, adresse client/prestataire,
- card.number, cvv, IBAN, BIC,
- aucun token (idempotency key DB ok car déjà non sensible, mais `stripeCustomerId` redacté à `[REDACTED]`).

Whitelist explicite snapshot (figée en Build) :
- DB : `id, status, amountCents, currency, idempotencyKey, createdAt, updatedAt`.
- Stripe : `id, status, amount, currency, created`.

`sanitizeForFinanceSnapshot` réutilise `deepSanitize` (ADR-016) appliqué à toute valeur avant insert.

### 4.2 Stockage `stripeId` et chiffrement

`FinanceMismatch.stripeId` (ex. `pi_...`, `tr_...`, `re_...`) est **un identifiant**, pas un secret. Il n'est pas chiffré (cohérent avec `Payment.stripePaymentIntentId` qui n'est pas chiffré non plus).

Toutefois, on tronque l'`stripeId` à **24 chars** en logs / alerts (cf. `transferIdShort` Ticket 4.2). Forme complète seulement en DB + UI admin authentifiée.

### 4.3 Alertes Discord sans PII

`AlertingService.emit({ ..., context })` passe par `sanitizeForAlert` (ADR-017). Pour finance, on ajoute aux champs whitelistés `context` : `mismatchId`, `runId`, `resourceKind`, `mismatchType`, `severity`, `amountDeltaCents` (sans email/userId). `stripeId` peut être inclus tronqué.

### 4.4 RBAC actions admin finance

| Endpoint Ticket 4.5 (préfigurés, Build différé) | Rôle minimum | RBAC supplémentaire |
|---|---|---|
| `GET /v1/admin/finance/mismatches` | `ADMIN` | aucun |
| `GET /v1/admin/finance/mismatches/:id` | `ADMIN` | aucun |
| `PATCH /v1/admin/finance/mismatches/:id/resolve` | `ADMIN` | + `reason` requis (≥ 16 chars) |
| `PATCH /v1/admin/finance/mismatches/:id/ignore` | `ADMIN` | + `reason` requis |
| `POST /v1/admin/finance/runs/manual` | **`SUPER_ADMIN`** ? (OQ-13) | rate-limit 1/heure |
| `GET /v1/admin/finance/daily-report` | `ADMIN` | aucun |
| `GET /v1/admin/finance/daily-report.csv` | `ADMIN` | seulement si OQ-14 = oui |

Toute mutation → entrée `MissionEvent` (ou `AdminAction` Ticket 4.3) avec `actorUserId` + `reason`.

### 4.5 Conformité comptable

- Aucune des décisions ne touche aux obligations de **conservation 10 ans des données paiement** (Code de commerce L123-22) — les rows `Payment/Transfer/Refund` ne sont pas supprimées par la reconciliation.
- `FinanceDailyReport` est conservé 5 ans (pratique recommandée) — non requis légalement car les données sources sont déjà conservées 10 ans, mais utile pour les audits internes.
- Aucune action automatique ne peut violer un audit trail : tout `markResolved` requiert un `actorUserId` + `reason`.

---

## 5. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **Stripe Sigma / Stripe Reports + dashboard custom** | Coût Sigma >100 €/mois MVP. Pas de croisement bidirectionnel Stripe ↔ DB (Sigma ne voit que Stripe). |
| **Reconciliation event-driven** (sur chaque webhook → check cohérence immédiate) | Multiplie les appels Stripe par 5-10× sur les ressources actives. Quota saturé. La reconciliation différée 24 h est suffisante (MTTD < 24 h acceptable). |
| **Correction automatique conservatrice** dès MVP (ex. fix `Transfer.status` si Stripe dit SENT mais DB dit PENDING) | Risque trop élevé sans observation prod préalable : un fix automatique peut masquer un bug d'orchestration plus grave. Décision : observer 90 j, automatiser après ADR dédiée. |
| **Tout en logs/metrics, pas de table `FinanceMismatch`** | Investigation impossible au-delà de 30 j (rotation logs). Métrique Prometheus n'identifie pas la row → ne sert qu'au dashboarding agrégé. **Refusé par P5 (audit obligatoire)**. |
| **Webhook Stripe `*.created` permettant détection temps réel** | Stripe ne fournit pas tous les events nécessaires (ex. pas d'event pour une mise à jour de balance prestataire). Couverture partielle insuffisante. |
| **Reconciliation hebdomadaire seulement (cron weekly)** | MTTD passe à 7 j — inacceptable pour les invariants comptables. |
| **Snowflake / data warehouse externe** | Sur-engineering MVP. Latence ingestion incompatible avec MTTD < 24 h. |

---

## 6. Conséquences

### Positives

- Détection des dérives Stripe ↔ DB en < 24 h (MTTD cible : 4-6 h grâce au cron horaire stuck funds).
- Audit financier complet via `FinanceMismatch` + `MissionEvent` (traçabilité 10 ans).
- Alerting bordé (P1/P2 + cooldown) → pas d'alert fatigue.
- 0 PII dans les snapshots ni les labels métriques.
- Quota Stripe largement préservé (< 1 % au MVP).
- Compatible PRD-005 (Disputes) sans refonte — la reconciliation lit déjà tout ce qu'il faut.

### Négatives / coûts assumés

- 4 nouvelles tables Prisma (migration coût Build moyen — non bloquant).
- Pas de correction automatique → charge admin manuelle de résolution mismatch (estimée MVP : < 5 mismatchs/semaine).
- Risque résiduel : un mismatch ignoré par l'admin reste en DB indéfiniment (état `IGNORED` avec reason mandatory atténue).
- ~50 lignes de cron à maintenir par poste (4 schedulers).

### Neutres (à surveiller)

- Évolution du volume mismatchs en prod T+30/+90 j — déclenche éventuellement ADR-019 sur automation.
- Quota Stripe `retrieve` si Clean Connect dépasse 1000 missions/jour → re-évaluer p-limit.
- Décision OQ-11 (DB vs logs) à reconfirmer si volume mismatchs reste < 1/mois — auquel cas logs/métriques pourraient suffire ; mais la déstabilisation n'en vaut pas la chandelle.

---

## 7. Suivi

- [ ] Mise à jour `CLAUDE.md` si nécessaire — pas requis (ADR-018 ne change pas les conventions backend).
- [ ] Mise à jour rule `.cursor/rules/securite.mdc` — non requis (les règles existantes suffisent).
- [ ] Code aligné dans la PR Build Ticket 4.5 : à ouvrir après sign-off CTO Design.
- [ ] Métriques d'impact instrumentées (cf. PRD §4.15 metrics list).
- [ ] Réévaluation T+90 j prod : volume mismatchs + besoin d'automation conservatrice.

---

## 8. Références

- PRD lié : `docs/prd/PRD-004-hardening-ops-compliance.md` §2.5 + §4.15
- Pré-revue sécurité : `docs/security-reviews/2026-05-12-prd-004-financial-monitoring-design-prereview.md`
- Runbook : `docs/ops/finance-reconciliation-runbook.md`
- ADRs liées : `ADR-008` (escrow Stripe Connect Express), `ADR-014` (observability), `ADR-015` (BullMQ/DLQ), `ADR-016` (Pino redaction), `ADR-017` (alerting strategy)
- Stripe API doc : [Rate limits](https://stripe.com/docs/rate-limits) — 100 req/s par account
- Stripe API doc : [Authorization holds Visa/MC](https://stripe.com/docs/payments/intents#authorization-holds) — 7 jours

---

*Template ADR Clean Connect v1.0 — méthode [BMAD-light](../method/BMAD.md)*
