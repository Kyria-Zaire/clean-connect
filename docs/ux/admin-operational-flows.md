# UX — Admin operational flows (web console)

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md) §6 (Admin Tooling UX) + sous-PRD futur **PRD-005B**
> **Glossaire** : [state-glossary.md](state-glossary.md)
> **State machine** : [mission-lifecycle-map.md](mission-lifecycle-map.md)
>
> Document **doc-only**. Cible : Admin Web Console (Vite + React + TS), accès **VPN/interne** MVP (cf. PRD-005 §10 Q4).
> ⚠️ **Pas d'écran codé**, pas de composant React. Pas de design fancy — admin tooling = utility-first, table-heavy, audit-ready.

---

## 1. Périmètre Admin MVP

| Surface | MVP 005B | Hors MVP |
|---|---|---|
| Monitoring finance | ✅ | — |
| Mismatches finance (workflow) | ✅ | — |
| Daily report finance | ✅ (consultation) | Export CSV avancé |
| DLQ webhooks (Stripe + Cloudinary) | ✅ (read + replay) | Édition payload |
| Bull Board (BullMQ) | ✅ (read-only intégré) | Édition jobs |
| Audit timeline mission | ✅ | Filtrage avancé |
| Refunds admin | ✅ | — |
| Rollback feature flags | ✅ | UI de gestion FF globale |
| RGPD : export / suppression compte | ✅ (utilitaires) | Workflow demande automatique |
| Suspension prestataire | ✅ (minimal) | Workflow appel |

---

## 2. Authentification & sécurité

### 2.1 Accès

| Aspect | Règle MVP |
|---|---|
| Réseau | VPN ou whitelist IP (décision CTO PRD-005 §10 Q4) |
| Auth | JWT `Role=ADMIN` ; refresh 30j ; SSO ouvert pour PRD futur |
| RBAC | `@Roles(Role.ADMIN)` sur toutes routes `/v1/admin/*` |
| Audit | `audit_log` table pour toute action admin (qui, quoi, quand, motif) |
| 2FA | Hors MVP — ouvert PRD-005D / sécu |

### 2.2 Session admin

- Inactivité → déconnexion après 60 min (cf. règle sécurité)
- Logout explicite invalide refresh token
- Toute action critique (refund, suspension) demande confirmation **+ saisie motif** (champ `actionReason` côté audit)

---

## 3. Monitoring finance

> Source : module `finance/` (controllers/admin-finance.controller.ts) + glossaire §6.

### 3.1 Dashboard finance (`/admin/finance`)

```
[Dashboard finance]
   ├─ Cartes synthèse (refresh 60s polling)
   │   - Mismatches OPEN : N (par type)
   │   - Mismatches ACKNOWLEDGED : N
   │   - Daily report J-1 : ✅ envoyé / ⚠️ pending / ❌ échec
   │   - Schedulers actifs : 5/5 (RECONCILE, STUCK, INVARIANTS, REPORT, PAYOUT_ANOMALY)
   │   - Feature flag FF_FINANCE_MONITORING_ENABLED : ON / OFF
   │
   ├─ Tableau « Mismatches récents » (top 20)
   │   - Filtres : status, type, resource kind, date range
   │   - Tri : detectedAt DESC par défaut
   │
   └─ Bouton « Lancer un run manuel » (rate-limit serveur OQ-13)
        ─► POST /v1/admin/finance/runs/manual
           (body vide — le run est toujours de type **RECONCILE** ;
           cf. `AdminFinanceController` + `FinanceReconcileService.runManual`)
```

### 3.2 Polling vs realtime

- **Polling** TanStack Query toutes les 60s (PRD-005 §5.11.4)
- Refresh manuel autorisé (bouton « Actualiser »)
- **Pas de WebSocket** MVP

### 3.3 Run manuel

```
[Bouton « Run manuel »]
   │
   ▼
[Modal confirmation]
   - Texte : « Lancer une réconciliation manuelle (fenêtre 7 j glissante) ? »
   - Champ « Motif » optionnel côté **UI** (recommandé pour audit interne —
     le backend actuel n'exige pas de body ; si besoin traçabilité stricte,
     ajouter un champ `reason` au DTO en phase Design 005B + migration audit).
   │
   ▼
POST /v1/admin/finance/runs/manual
   (sans body JSON — auth JWT suffit)
   │
   ▼
   ┌──────────────────┬─────────────────────┐
   │ 202 Accepted     │ 429 Too Many        │
   │ { accepted,      │ Requests            │
   │   runId }        │ { error:             │
   │                  │  FINANCE_MANUAL_     │
   │                  │  RUN_RATE_LIMIT }    │
   │                  │ (quota 1h glissant   │
   │                  │  par admin)          │
   │                  ├─────────────────────┤
   │                  │ 409 Conflict         │
   │                  │ { error:             │
   │                  │  FINANCE_RECONCILE_  │
   │                  │  BUSY }              │
   └────────┬─────────┴─────────────────────┘
            ▼
   [Modal « Run en cours »]
   - Polling 5s sur statut (via `GET /v1/admin/finance/mismatches?…` ou
     endpoint dédié run si exposé en Design 005B)
   - FinanceRunStatus : RUNNING → COMPLETED / FAILED
   - Affichage : durée, nb mismatches détectés
```

### 3.4 Erreurs run manuel

| Cas | HTTP | Code body | UX |
|---|---|---|---|
| Rate limit OQ-13 (`FIN-MANUAL-RATELIMIT`) | 429 | `FINANCE_MANUAL_RUN_RATE_LIMIT` | « Quota de runs manuels atteint — réessayez dans ≤ 1 h » + lien doc interne |
| Lock busy (cron ou autre manuel en cours) | 409 | `FINANCE_RECONCILE_BUSY` | « Une réconciliation est déjà en cours — patientez » |
| FF désactivé | 503 | *(selon guard global)* | « Monitoring finance désactivé — voir SRE » |
| Monitoring désactivé côté app | 503 | — | Idem |

---

## 4. Visualisation mismatches (`/admin/finance/mismatches`)

### 4.1 Table

```
[Table mismatches]
   - Colonnes : detectedAt | type | resourceKind | resourceId | status | severity | adminAssignee | actions
   - Filtres :
       - status: OPEN / ACKNOWLEDGED / INVESTIGATING / RESOLVED / IGNORED
       - type: STATUS / AMOUNT / CURRENCY / MISSING_DB / MISSING_STRIPE /
               INVARIANT_SUM / STUCK_PENDING / STUCK_AUTHORIZATION /
               STUCK_CAPTURED / PAYOUT_ANOMALY
       - resourceKind: PAYMENT / TRANSFER / REFUND / INVARIANT
       - date range
   - Pagination keyset
   - Bulk select (max 20) pour transitions de masse
```

### 4.2 Détail mismatch

```
[Détail FinanceMismatch]
   │
   ├─ Métadonnées
   │   - ID, detectedAt, type, severity (dérivé du type)
   │   - resourceKind + resourceId (+ lien interne mission / payment)
   │   - status actuel + history (transitions précédentes)
   │
   ├─ Snapshots
   │   - dbSnapshot (JSON déredacté — whitelist FINANCE_SNAPSHOT_WHITELIST)
   │   - stripeSnapshot (idem)
   │   - delta (diff calculé serveur)
   │
   ├─ Lien Stripe Dashboard (si pertinent)
   │
   ├─ Notes admin (textarea avec audit log)
   │
   └─ Actions
       - « Acknowledge »   (OPEN → ACKNOWLEDGED)
       - « Investigate »   (OPEN/ACKNOWLEDGED → INVESTIGATING)
       - « Resolve »       (* → RESOLVED — motif obligatoire)
       - « Ignore »        (* → IGNORED — motif obligatoire)
```

### 4.3 Transitions strictes

> Source : `schema.prisma` lignes 235-249 + `FinanceMismatchService.transition`.

```
OPEN ─► ACKNOWLEDGED ─► INVESTIGATING ─► RESOLVED
  │                          │            │
  │                          └─► IGNORED ◄┘
  │
  └─► RESOLVED / IGNORED (raccourci direct si motif documenté)

RESOLVED / IGNORED = terminaux (pas de retour OPEN sans nouveau mismatch)
```

UI applique strictement : boutons d'actions désactivés si transition interdite.

### 4.4 Erreurs UX

| Cas | HTTP | UX |
|---|---|---|
| Transition interdite | 409 | « Transition impossible : <from> → <to>. » |
| Mismatch introuvable | 404 | « Mismatch introuvable. » |
| Motif manquant pour RESOLVED/IGNORED | 400 | « Motif obligatoire. » |
| Concurrence (autre admin a modifié) | 409 | « Modifié par un autre admin — refresh. » |

---

## 5. DLQ Replay (webhooks Stripe)

> Source : table `WebhookDeadLetter` + `AdminRefundsAndDlqController` (`apps/api/src/modules/payments/admin-refunds-dlq.controller.ts`).
>
> **Cloudinary** : enum `WebhookDeadLetterSource.CLOUDINARY` existe en schéma, mais **aucune route admin DLQ Cloudinary** n’est livrée sur `main` au moment de ce document — **TODO Design 005B** (replay + liste unifiée).

### 5.1 Liste DLQ Stripe

```
GET /v1/admin/webhooks/stripe-dead-letters?limit=50&resolved=false
   │
   ▼
[Table DLQ]
   - Colonnes : receivedAt | eventType | stripeEventId | attempts | lastError | resolved | actions
   - Tri : receivedAt DESC
   - Pagination : `limit` borné (≤ 100) — pas de cursor keyset côté API actuelle
```

### 5.2 Détail DLQ entry

```
[Détail DLQ — écran admin futur]
   - eventType (`payment_intent.succeeded`, `charge.refunded`, etc.)
   - Payload stocké (déredacté — pas de PII)
   - History tentatives + erreurs
   - Bouton « Replay »
```

### 5.3 Replay

```
POST /v1/admin/webhooks/stripe-dead-letters/:id/replay
   → 202 { accepted: true }
   (idempotence côté `stripe_event_id` — rejeu sans doublon métier)
```

### 5.4 Erreurs DLQ

| Cas | HTTP | UX |
|---|---|---|
| Déjà traité (idempotent) | 200/202 selon impl. | « Déjà traité — aucune action » |
| Signature invalide (rare en DLQ) | 400 | Bandeau rouge — escalation SRE |
| Mismatch livemode | 400 `WEBHOOK_LIVEMODE_MISMATCH` | « Environnement mismatch — refus » |
| Resource introuvable | 404 | « Entrée DLQ introuvable » |

---

## 6. Observabilité

### 6.1 BullBoard intégré

> Read-only — affichage des queues BullMQ.

```
[/admin/queues] (proxy BullBoard ou iframe sécurisé)
   - Queues : webhooks-stripe, webhooks-cloudinary, photos-upload-sync,
              transfers, refunds, auto-release, finance-runs
   - Statuts : waiting, active, completed, failed, delayed
   - Aucun bouton retry/replay en MVP (admin → DLQ table dédiée)
```

### 6.2 Métriques

```
[/admin/observability]
   - Lien externe Grafana (auth séparée)
   - Métriques Prometheus disponibles (lecture seule) :
       cleanconnect_finance_mismatches_total{type, status}
       cleanconnect_finance_runs_total{type, status}
       cleanconnect_payments_*
       cleanconnect_transfers_*
       cleanconnect_photos_upload_*
       cleanconnect_bullmq_queue_*
```

### 6.3 Health check

```
GET /healthz  (public)
GET /v1/admin/observability/health  (admin — détaillé)
   {
     status: "ok" | "degraded" | "down",
     db: ..., redis: ..., stripe: ..., cloudinary: ...,
     schedulers: { reconcile: lastRunAt, stuck: ..., ... }
   }
```

---

## 7. Audit timeline

### 7.1 Vue mission (`/admin/missions/:id/timeline`)

```
[Timeline mission]
   - Événements chronologiques (table `MissionEvent` ou équivalent)
   - Colonnes : timestamp | actor (user + role) | action | from → to | metadata
   - Source : routes mission + webhooks + scheduler runs liés
   - Filtre par type d'événement
```

### 7.2 Événements typiques

| Source | Événement | Affichage |
|---|---|---|
| `POST /missions` | Mission créée | DRAFT, actor=CLIENT |
| `POST /payments/intent` | PaymentIntent créé | actor=CLIENT, missionId, amount |
| Webhook `amount_capturable_updated` | Payment autorisé | actor=SYSTEM, eventId |
| `POST /:id/accept` | Mission acceptée | actor=PRESTATAIRE |
| `POST /presign` (×N) | Sessions upload créées | actor=PRESTATAIRE, phase |
| `POST /confirm` (×N) | Photos confirmées | photoId, syncedAt |
| `POST /:id/complete` | Mission complétée | actor=PRESTATAIRE |
| Webhook `payment_intent.succeeded` | Capture confirmée | actor=SYSTEM |
| `POST /:id/validate` | Validée client | actor=CLIENT |
| `POST /:id/report-problem` | Litige ouvert | actor=CLIENT, category |
| Auto-release executor | Capture auto-release | actor=SYSTEM |
| Admin `POST /admin/payments/:id/refund` | Refund admin | actor=ADMIN, reason |
| FinanceMismatch detected | Mismatch détecté | actor=SCHEDULER, type |
| Mismatch transition | Status changé | actor=ADMIN, from→to |

---

## 8. Refunds admin

> Source : `payments.errors.ts` (`PaymentRefundBlockedTransferSentException`, `PaymentPartialRefundNotSupportedException`).

### 8.1 Flow

```
[Détail mission COMPLETED ou DISPUTE_OPEN]
   │
   ▼
[Bouton « Refund intégral »]
   │
   ▼
[Modal confirmation]
   - Montant : <amountCapturedCents> EUR (lecture seule, intégral obligatoire)
   - Motif obligatoire (audit)
   - Checkbox « Je confirme ne pas avoir versé au prestataire »
   │
   ▼
POST /v1/admin/payments/:paymentId/refund
   Body: { reason }
   │
   ▼
   ┌──────────────────────────────────┐
   │  200 OK → Refund PENDING         │
   │  Payment → REFUND_PENDING        │
   │  Webhook charge.refunded à venir │
   └──────────────────────────────────┘
```

### 8.2 Erreurs

| Cas | HTTP | Code | UX |
|---|---|---|---|
| Transfer déjà SENT | 409 | `PAYMENT_REFUND_BLOCKED_TRANSFER_SENT` | « Transfer prestataire déjà envoyé — traitement manuel Stripe Dashboard » |
| Refund partiel demandé | 422 | `PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED` | « Seul le refund intégral est supporté en MVP » |
| Payment pas refundable (état) | 409 | `PAYMENT_INVALID_STATE` | « Ce paiement ne peut être remboursé » |
| Mission introuvable | 404 | `MISSION_NOT_FOUND` | « Mission introuvable » |

---

## 9. Daily report finance

### 9.1 Consultation

```
GET /v1/admin/finance/daily-report/:date  (date = YYYY-MM-DD Europe/Paris)
   │
   ▼
[Affichage rapport]
   - Période : J-1 00:00 → J-1 23:59 Europe/Paris
   - Sections :
       - Volume paiements (autorisations, captures, refunds)
       - Transfers prestataires (PENDING/SENT/FAILED/REVERSED)
       - Mismatches détectés / résolus / ouverts
       - Schedulers exécutés (count par type, duration)
       - Anomalies notables
   - Bouton « Export CSV » (PRD-005B+)
```

### 9.2 Envoi quotidien

- Cron `REPORT` → email admin (Resend)
- Si email KO → DLQ admin (à monitorer)
- Pas de PII dans l'email — agrégats uniquement

---

## 10. Rollback feature flags

> Cas d'urgence — pas un usage routine.

### 10.1 Procédure documentée (pas UI MVP)

Le rollback `FF_FINANCE_MONITORING_ENABLED=false` est **manuel SRE** via :
- Vault / secret manager
- Redéploiement `cc-api` ou hot-reload selon stack

Cf. [`docs/runbooks/finance-monitoring-activation.md`](../runbooks/finance-monitoring-activation.md).

### 10.2 UI MVP : affichage de l'état FF uniquement

```
[Dashboard finance — bandeau d'état]
   - FF_FINANCE_MONITORING_ENABLED : ON / OFF
   - Si OFF : bandeau jaune « Monitoring désactivé — pas de scheduler »
   - Pas de bouton on/off dans l'UI (sécurité — manuel SRE)
```

> Pour PRD-005B : décider si on expose un toggle UI sécurisé (2 sign-offs) ou si on garde manuel. Recommandation : **garder manuel** pour MVP (PRD-005 §10 Q11 — boring + sécu).

---

## 11. Incident handling

### 11.1 Lecture des incidents (table `incident_log` ou équivalent — à concevoir Design 005B)

```
[/admin/incidents]
   - Liste incidents P0/P1/P2/P3
   - Colonnes : openedAt | severity | category | status | assignee | mttr
   - Lien post-mortem si disponible
```

### 11.2 Catégorisation

> Conforme à [`docs/runbooks/finance-monitoring-incident-playbook.md`](../runbooks/finance-monitoring-incident-playbook.md).

| Sévérité | UX admin |
|---|---|
| P0 | Bandeau rouge persistant + alerte sonore option |
| P1 | Bandeau orange |
| P2 | Notification dans Dashboard |
| P3 | Visible uniquement page incidents |

---

## 12. Emergency procedures (UX dégradée admin)

### 12.1 FF désactivé en urgence

```
[Dashboard finance avec FF=OFF]
   - Bandeau rouge persistant
   - Schedulers grisés (lastRunAt freezed)
   - Mismatches existants restent consultables (read-only)
   - Pas de nouveau mismatch détecté (logique : FF gate-keep)
   - Pas de run manuel possible (503)
```

### 12.2 Maintenance mode global (futur)

Hors scope MVP — décision PRD futur. Placeholder UX :
- Bandeau global « Maintenance — opérations limitées »
- Lecture seule sur la majorité des routes
- Liste explicite des actions désactivées

---

## 13. Gestion utilisateurs (utilitaires RGPD)

### 13.1 Recherche utilisateur

```
[/admin/users]
   - Recherche par email exact (pas de fuzzy — sécu PII)
   - Filtres : role, suspendedAt, verifiedAt, deletedAt
```

### 13.2 Détail utilisateur

```
[/admin/users/:id]
   ├─ Identité (email partiellement masqué)
   ├─ Role + Stripe identifiers
   ├─ ProviderPayoutStatus (si PRESTATAIRE)
   ├─ Stats : missions créées / acceptées / litiges
   ├─ Audit récent
   │
   └─ Actions
       - « Exporter RGPD » → trigger /users/:id/export (admin variante)
       - « Suspendre » → set suspendedAt + motif (audit)
       - « Réactiver » → suspendedAt=null + motif
       - « Soft delete RGPD » → set deletedAt (30j puis purge)
```

### 13.3 Règles dures admin

- ❌ Pas d'édition directe du mot de passe (admin envoie email reset)
- ❌ Pas de visibilité PII complète (cartes Stripe, numéros téléphone)
- ❌ Suppression dure (`DELETE FROM users`) **interdite** — soft delete uniquement
- ✅ Audit log obligatoire sur toutes ces actions

---

## 14. Suspension prestataire

### 14.1 Flow

```
[Détail prestataire suspect (fraude / KYC issue)]
   │
   ▼
[Bouton « Suspendre »]
   │
   ▼
[Modal]
   - Motif obligatoire (catégories : FRAUD / KYC / POLICY_VIOLATION / OTHER)
   - Notes libres
   - Notification email automatique (Resend) au prestataire
   │
   ▼
PATCH /v1/admin/users/:id { suspendedAt: now, reason, notes }
   │
   ▼
   ┌──────────────────────────────────────┐
   │  Backend :                           │
   │  - Filtrage matching exclut user     │
   │  - Login refusé au prochain check    │
   │  - Audit log                         │
   └──────────────────────────────────────┘
```

### 14.2 Missions en cours du prestataire suspendu

Décision PRD-005 §10 Q9 (non traitée en MVP — TODO Design 005B) :
- Maintenir les missions en cours **OU** auto-cancel toutes ?
- **Recommandation par défaut** : maintenir + escalation manuelle admin pour chaque mission

---

## 15. Edge cases admin

| Cas | UX |
|---|---|
| Concurrence 2 admins sur même mismatch | 409 + force refresh ; dernier write protégé par version |
| Refund tenté alors qu'un autre admin l'a fait | 409 `PAYMENT_INVALID_STATE` + refresh |
| Action audit log impossible (DB down) | Bloquer l'action — pas de bypass |
| Token admin expiré pendant action | Refresh transparent ou logout forcé selon ancienneté |
| Mass select > 20 mismatches | Limiter à 20, message « Sélection limitée à 20 — exécutez en plusieurs lots » |
| FF désactivé pendant action en cours | 503 sur tentative → message clair « Module désactivé » |

---

## 16. Différences clés avec mobile

| Aspect | Mobile (CLIENT/PRESTATAIRE) | Admin Web |
|---|---|---|
| Stack | Expo + RN | Vite + React |
| State serveur | TanStack Query polling | TanStack Query polling |
| State local | Zustand + MMKV | Zustand (transient) |
| Forms | react-hook-form + Zod | react-hook-form + Zod |
| Design System | NativeWind | shadcn/ui |
| Offline | Partial (photos uniquement) | Aucun (admin online only) |
| Push | Hors MVP (005C) | Hors MVP (futur) |
| Auth | JWT + biométrie locale (option) | JWT + VPN |

---

## 17. Non-goals admin MVP

> Conformes à PRD-005 §5.12 (Frontend Non-Goals).

- ❌ Pas de bulk-edit avancé > 20
- ❌ Pas de drag & drop
- ❌ Pas de keyboard shortcuts custom
- ❌ Pas de thème dark/light (light only MVP)
- ❌ Pas d'export CSV avancé (PRD-005D)
- ❌ Pas de dashboarding personnalisable
- ❌ Pas de SSO (PRD futur)
- ❌ Pas de chat support intégré
- ❌ Pas de notifications navigateur (Web Push)
- ❌ Pas d'édition directe BullMQ jobs

---

*Document produit le 2026-05-13. Aligné sur `admin-finance.controller.ts`, `admin-payments.controller.ts`, `admin-refunds-dlq.controller.ts`, `admin-transfers.controller.ts` mergés sur `main`. Utility-first, audit-ready, boring.*
