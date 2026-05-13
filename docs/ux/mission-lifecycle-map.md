# UX — Cartographie du cycle de vie mission

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md)
> **Source backend** : `apps/api/prisma/schema.prisma` + `apps/api/src/modules/missions/domain/mission-state.machine.ts` + `mission-completion.errors.ts` + `payments.errors.ts`
> **Glossaire** : [state-glossary.md](state-glossary.md)
>
> ⚠️ **Aucun écran, aucune maquette, aucun composant.** Document UX-métier produisant la **state machine officielle** + matrice **RACI** + tableaux d'états + erreurs attendues.

---

## 1. Vue d'ensemble — state machine textuelle

### 1.1 Diagramme ASCII (graphe officiel MVP)

```
                              ┌────────────┐
                              │   DRAFT    │  (CLIENT crée la mission)
                              └─────┬──────┘
                                    │ POST /v1/payments/intent
                                    │ (Idempotency-Key obligatoire)
                                    ▼
                            ┌───────────────────┐
                            │ PENDING_PAYMENT   │ ◄── 🔵 attente webhook
                            │ (PaymentStatus =  │     `payment_intent.amount_
                            │ AUTHORIZATION_    │      capturable_updated`
                            │ PENDING)          │
                            └────┬──────────┬───┘
                                 │          │
                webhook OK ──────┘          └──── webhook KO / annulation 7j
                                 │                       │
                                 ▼                       ▼
                          ┌────────────┐          ┌────────────┐
                          │ PUBLISHED  │          │ CANCELLED  │ ⚫
                          └─────┬──────┘          └────────────┘
                                │
                  PRESTATAIRE — POST /v1/missions/:id/accept
                                │
                                ▼
                          ┌────────────┐
                          │ ACCEPTED   │ (PaymentStatus = AUTHORIZED)
                          └─────┬──────┘
                                │
                  PRESTATAIRE — upload BEFORE (≥3) + AFTER (≥5)
                  PRESTATAIRE — POST /v1/missions/:id/complete
                                │ (garde-fou photos serveur)
                                ▼
                ┌────────────────────────────────┐
                │ CLIENT_VALIDATION_PENDING       │
                │ Auto-release programmé T+48h    │
                │ ouvrées (BullMQ delayed job)    │
                └───────┬───────────────┬─────────┘
                        │               │
       CLIENT valide    │               │   CLIENT /report-problem
       POST /validate   │               │   ou auto-release T+48h ouvré
                        │               │   ou transfer.reversed (Stripe)
                        ▼               ▼
              ┌────────────────┐  ┌────────────────┐
              │   COMPLETED    │  │  DISPUTE_OPEN  │  ⚫ terminal MVP
              │ (Payment =     │  └────────────────┘
              │  CAPTURED ;    │
              │  webhook PI    │
              │  succeeded)    │
              └───────┬────────┘
                      │  (admin)
                      │  POST /v1/admin/payments/:id/refund
                      │  (transfer NOT SENT)
                      ▼
              ┌────────────────┐
              │   REFUNDED     │ ⚫ terminal
              │ (Payment =     │
              │ REFUND_PENDING │
              │ → REFUNDED)    │
              └────────────────┘

Branches terminales sans suite :
  EXPIRED   ⚫  (TTL publication non atteinte par un prestataire)
  CANCELLED ⚫  (annulation CLIENT — DRAFT/PUBLISHED/ACCEPTED)
```

### 1.2 États « réservés » non utilisés en MVP

| Code | Raison | Décision MVP |
|---|---|---|
| `PROPOSED` | Le marketplace utilise `MissionProposal` (table dédiée) — mission reste `PUBLISHED` pendant TTL | Pas rendu en UI |
| `IN_PROGRESS` | Pas d'endpoint `/start` (TODO debt `mission-start-endpoint`) | Pas rendu en UI |

> ✍️ *Note PRD-005A* : `IN_PROGRESS` pourrait être affiché côté UI **dérivé** de `ACCEPTED` + 1ère photo `AFTER` syncée, sans changer le statut serveur. À trancher en Design 005A.

---

## 2. Transitions strictes (extrait `MISSION_TRANSITIONS_MVP`)

> Toute mutation HTTP qui violerait ces transitions remonte **`MissionInvalidStatusTransitionError` → HTTP 409 Conflict** (mappé `MISSION_NOT_COMPLETABLE` ou `MISSION_NOT_VALIDATABLE` selon route).

| Depuis | Vers autorisé | Déclencheur | Acteur |
|---|---|---|---|
| `DRAFT` | `PENDING_PAYMENT`, `PUBLISHED`, `CANCELLED` | `POST /v1/payments/intent` ou `POST /:id/publish` (FF off) ou `DELETE /:id` | CLIENT |
| `PENDING_PAYMENT` | `PUBLISHED`, `CANCELLED` | Webhook `payment_intent.amount_capturable_updated` ou `canceled` | Stripe (système) |
| `PUBLISHED` | `ACCEPTED`, `EXPIRED`, `CANCELLED` | `POST /:id/accept` (PRESTATAIRE) / cron expiration / `DELETE /:id` (CLIENT) | PRESTATAIRE / système / CLIENT |
| `PROPOSED` | `ACCEPTED`, `EXPIRED`, `CANCELLED` | *(non utilisé MVP)* | — |
| `ACCEPTED` | `CLIENT_VALIDATION_PENDING`, `CANCELLED` | `POST /:id/complete` (PRESTATAIRE) ou `DELETE /:id` (CLIENT) | PRESTATAIRE / CLIENT |
| `IN_PROGRESS` | `CLIENT_VALIDATION_PENDING`, `CANCELLED` | *(non utilisé MVP)* | — |
| `CLIENT_VALIDATION_PENDING` | `COMPLETED`, `DISPUTE_OPEN`, `CANCELLED` | Webhook `payment_intent.succeeded` (validate ou auto-release) ; `POST /:id/report-problem` ; `DELETE /:id` (CLIENT) | Système / CLIENT |
| `COMPLETED` | `DISPUTE_OPEN` | Webhook `transfer.reversed` ; fenêtre 7j post completion *(PRD-005C)* | Stripe / système |
| `DISPUTE_OPEN` | — | Terminal MVP | — |
| `EXPIRED`, `CANCELLED`, `REFUNDED` | — | Terminaux | — |

---

## 3. Tableau d'états complet (mission)

> Pour chaque état : description, acteur principal, UI attendue (sémantique — pas de visuel), actions possibles, actions interdites, transition suivante, erreur possible, fallback UX.

### 3.1 `DRAFT`

| Champ | Valeur |
|---|---|
| **Description** | Mission créée, non publiée, non payée |
| **Acteur principal** | CLIENT |
| **UI attendue** | Formulaire éditable + bouton « Payer pour publier » |
| **Actions possibles** | Modifier ; supprimer ; lancer paiement (`POST /v1/payments/intent`) |
| **Actions interdites** | Accepter (PRESTATAIRE 403) ; uploader photos (409 mission pas ACCEPTED) |
| **Transitions sortantes** | `PENDING_PAYMENT` (paiement), `PUBLISHED` (legacy FF off), `CANCELLED` (delete) |
| **Erreurs métier** | 422 `PAYMENT_AMOUNT_REQUIRED`, 400 `PAYMENT_MISSING_IDEMPOTENCY_KEY` |
| **Fallback UX** | Si paiement KO → reste en DRAFT, message « Réessayez le paiement » |

### 3.2 `PENDING_PAYMENT`

| Champ | Valeur |
|---|---|
| **Description** | PaymentIntent créé (capture_method=manual), attente webhook Stripe |
| **Acteur principal** | Système (webhook) — utilisateur en attente |
| **UI attendue** | État verrouillé « Paiement en cours… » + spinner + bouton « Actualiser » |
| **Actions possibles** | Refresh manuel ; annuler la mission (transition `CANCELLED`) |
| **Actions interdites** | Re-publier, accepter, uploader |
| **Transitions sortantes** | `PUBLISHED` (webhook OK), `CANCELLED` (cancel client ou expiration 7j) |
| **Erreurs métier** | 409 `PAYMENT_INVALID_STATE` si retry sur même mission |
| **Fallback UX** | Polling 5s × 6 max ; au-delà → message « Toujours en cours. Réessayez plus tard. » |

### 3.3 `PUBLISHED`

| Champ | Valeur |
|---|---|
| **Description** | Mission visible des prestataires éligibles (zone + capabilities Stripe) |
| **Acteur principal** | PRESTATAIRES (lecture) ; CLIENT (lecture + annulation) |
| **UI attendue** | CLIENT : « En attente d'un prestataire » + bouton annuler ; PRESTATAIRE : carte mission dans `/proposed` |
| **Actions possibles** | CLIENT : `DELETE /:id` ; PRESTATAIRE : `POST /:id/accept` |
| **Actions interdites** | CLIENT : uploader, valider ; PRESTATAIRE : uploader avant `accept` |
| **Transitions sortantes** | `ACCEPTED`, `EXPIRED`, `CANCELLED` |
| **Erreurs métier** | 409 mission non acceptable (déjà acceptée, TTL expiré) |
| **Fallback UX** | Si TTL atteint sans acceptation → bascule `EXPIRED` |

### 3.4 `ACCEPTED`

| Champ | Valeur |
|---|---|
| **Description** | Prestataire accepté, autorisation Stripe maintenue |
| **Acteur principal** | PRESTATAIRE (exécution) ; CLIENT (lecture) |
| **UI attendue** | CLIENT : « Prestataire confirmé pour le … » ; PRESTATAIRE : page mission + presign upload BEFORE/AFTER |
| **Actions possibles** | PRESTATAIRE : `POST /presign` + `POST /confirm` (photos) + `POST /:id/complete` ; CLIENT : `DELETE /:id` |
| **Actions interdites** | CLIENT : valider (409 `MISSION_NOT_VALIDATABLE`) ; PRESTATAIRE : modifier la mission, demander un nouveau paiement |
| **Transitions sortantes** | `CLIENT_VALIDATION_PENDING` (complete), `CANCELLED` |
| **Erreurs métier** | 409 `MISSION_PHOTOS_INSUFFICIENT` à `/complete` ; 403 `MISSION_PRESTATAIRE_ONLY` |
| **Fallback UX** | Si `complete` échoue (photos insuffisantes) → message « Encore X photos BEFORE / Y photos AFTER nécessaires » |

### 3.5 `CLIENT_VALIDATION_PENDING`

| Champ | Valeur |
|---|---|
| **Description** | Mission terminée côté prestataire ; auto-release T+48h ouvrées programmé |
| **Acteur principal** | CLIENT (action requise) ; système (auto-release fallback) |
| **UI attendue** | CLIENT : alerte « Validation requise sous T+48h » + photos AFTER + boutons « Valider » / « Signaler un problème » ; PRESTATAIRE : « En attente du client » |
| **Actions possibles** | CLIENT : `POST /:id/validate`, `POST /:id/report-problem`, ou `DELETE /:id` (annulation — libération autorisation Stripe côté serveur, cf. `MissionsService.cancel` + `assertMissionTransition`) ; système : auto-release si timeout |
| **Actions interdites** | PRESTATAIRE : reprendre, re-uploader (mission en lecture seule pour lui) ; CLIENT : **aucune** action interdite côté state machine (annulation autorisée — à confirmer métier Design 005A : message UX « annuler = abandonner la validation ») |
| **Transitions sortantes** | `COMPLETED` (validate ou auto-release), `DISPUTE_OPEN` (`report-problem`), `CANCELLED` (`DELETE` client) |
| **Erreurs métier** | 409 `PAYMENT_NOT_CAPTURABLE` si Payment ≠ AUTHORIZED ; 422 `PAYMENT_AUTHORIZATION_EXPIRED` (rare — 7j Stripe) ; 409 `MISSION_DISPUTE_ALREADY_OPEN` |
| **Fallback UX** | Si validate échoue → afficher message + retry ; si auto-release a déjà tiré → `COMPLETED` |

### 3.6 `COMPLETED`

| Champ | Valeur |
|---|---|
| **Description** | Capture Stripe confirmée ; mission terminale succès |
| **Acteur principal** | Lecture seule pour tous |
| **UI attendue** | CLIENT : « Mission terminée — payée » + reçu ; PRESTATAIRE : « Mission payée » + reçu |
| **Actions possibles** | Lecture seule ; télécharger facture *(future PRD-005D)* |
| **Actions interdites** | Reprendre, re-upload, refund (réservé ADMIN) |
| **Transitions sortantes** | `DISPUTE_OPEN` (rare — webhook `transfer.reversed`) |
| **Erreurs métier** | — |
| **Fallback UX** | Si transfer reversed → bascule UX vers « Litige ouvert — support en cours » |

### 3.7 `DISPUTE_OPEN` (terminal MVP)

| Champ | Valeur |
|---|---|
| **Description** | Litige ouvert (client `/report-problem` ou Stripe `charge.dispute.created` / `transfer.reversed`) |
| **Acteur principal** | ADMIN (instruction PRD-005C/006) |
| **UI attendue** | CLIENT : « Litige ouvert — support en cours » ; PRESTATAIRE : « Litige client — en attente d'instruction » ; pas de timer visible |
| **Actions possibles** | CLIENT : ajouter des informations *(future PRD-006)* ; PRESTATAIRE : ajouter sa version *(future PRD-006)* |
| **Actions interdites** | Validate (409), report-problem 2× (`MISSION_DISPUTE_ALREADY_OPEN`), auto-release (job annulé serveur) |
| **Transitions sortantes** | — terminal MVP |
| **Erreurs métier** | 409 `MISSION_DISPUTE_ALREADY_OPEN` |
| **Fallback UX** | Affichage figé avec contact support |

### 3.8 `EXPIRED`, `CANCELLED`, `REFUNDED`

Tous trois **terminaux**. Pas d'action utilisateur, écran d'historique uniquement.

| État | Message CLIENT | Message PRESTATAIRE | Raison affichée |
|---|---|---|---|
| `EXPIRED` | « Aucun prestataire n'a pris cette mission dans les délais. » | *(filtré hors `/proposed`)* | Oui (TTL atteint) |
| `CANCELLED` | « Mission annulée le … » | « Annulée par le client » | Oui (date) |
| `REFUNDED` | « Remboursée intégralement. » | « Mission remboursée — pas de versement. » | Motif admin saisi côté refund |

---

## 4. États de paiement / transfer / refund par état mission

> Vue croisée pour le frontend : *quand la mission est en X, le paiement est typiquement en Y*. Ne pas confondre `MissionStatus`, `PaymentStatus`, `TransferStatus`.

| MissionStatus | PaymentStatus attendu | TransferStatus attendu | RefundStatus | Auto-release programmé ? |
|---|---|---|---|---|
| `DRAFT` | (pas de Payment) | — | — | Non |
| `PENDING_PAYMENT` | `AUTHORIZATION_PENDING` | — | — | Non |
| `PUBLISHED` | `AUTHORIZED` | — | — | Non |
| `ACCEPTED` | `AUTHORIZED` | — | — | Non |
| `CLIENT_VALIDATION_PENDING` | `AUTHORIZED` | — | — | Oui (T+48h ouvrées) |
| `COMPLETED` | `CAPTURED` | `PENDING` → `SENT` (séparé) | — | Non (annulé / déjà tiré) |
| `DISPUTE_OPEN` | `AUTHORIZED` ou `CAPTURED` (selon timing) | `PENDING` / `SENT` / `REVERSED` | — | Non (annulé) |
| `EXPIRED` | (jamais autorisé) ou `CANCELLED` | — | — | Non |
| `CANCELLED` (depuis `DRAFT`/`PENDING_PAYMENT`) | `CANCELLED` ou n'existe pas | — | — | Non |
| `CANCELLED` (depuis `ACCEPTED`) | `CANCELLED` (release authorization) | — | — | Non |
| `REFUNDED` | `REFUND_PENDING` → `REFUNDED` | (NOT `SENT` — ADMIN refuse sinon 409) | `PENDING` → `REFUNDED` | Non |

---

## 5. Matrice RACI — actions critiques

> Légende : **R**esponsible (exécute), **A**ccountable (rend des comptes — 1 seul par ligne), **C**onsulted, **I**nformed.

| Action critique | CLIENT | PRESTATAIRE | ADMIN | SYSTÈME (BullMQ / cron / webhook) | DPO | OBSERVABILITÉ (SRE) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Créer mission** (`POST /missions`) | R, A | I | — | — | — | I (metrics) |
| **Initier paiement** (`POST /payments/intent`) | R, A | — | — | C (Stripe API) | — | I |
| **Webhook autorise paiement** (`amount_capturable_updated`) | I | I | — | R, A | — | I (alerts) |
| **Publier mission** (auto sur webhook OK) | I | I | — | R, A | — | I |
| **Accepter mission** (`POST /:id/accept`) | I | R, A | — | — | — | I |
| **Annuler mission** (avant ACCEPTED) | R, A | I | — | I (release authorization Stripe) | — | I |
| **Annuler mission** (depuis ACCEPTED) | R, A | I | C (rare — fraude) | I | — | I |
| **Upload BEFORE/AFTER** (presign + upload + confirm) | I | R, A | — | C (Cloudinary) | C (RGPD rétention) | I |
| **Compléter mission** (`POST /:id/complete`) | I | R, A | — | C (Stripe capture trigger différé) | — | I |
| **Valider mission** (`POST /:id/validate`) | R, A | I | — | C (capture Stripe sync) | — | I |
| **Auto-release T+48h ouvrées** | I | I | — | R, A | — | C (alert sur échec) |
| **Signaler un problème** (`POST /:id/report-problem`) | R, A | I | I (instruction à venir) | I (cancel auto-release job) | C (preuves utilisateur) | I |
| **Refund admin** (`POST /admin/payments/:id/refund`) | I | I | R, A | C (Stripe API) | C (RGPD audit) | I (alert) |
| **Replay DLQ webhook** (admin) | — | — | R, A | C (Redis/BullMQ) | — | I |
| **Résoudre mismatch finance** (admin) | — | — | R, A | I (audit timeline) | C (si données personnelles touchées) | I |
| **Rollback `FF_FINANCE_MONITORING_ENABLED`** | — | — | C | C (cluster) | — | R, A (SRE primaire) |
| **Suspension prestataire** (fraude) | I | I | R, A | I | C | I |
| **Export RGPD compte** (`/users/me/export`) | R, A | R, A | — | C | C | I |
| **Suppression compte RGPD** | R, A | R, A | C (10 ans paiement) | I (purge planifiée) | C | I |

---

## 6. DLQ webhooks et impact UX

> Source : `WebhookDeadLetterSource` (`STRIPE`, `CLOUDINARY`).

| Source | Impact UX client | Impact UX prestataire | Action admin |
|---|---|---|---|
| `STRIPE` (PI / Charge / Transfer / Refund) | Possible **désynchronisation** de l'état affiché (Payment apparaît `AUTHORIZED` alors que Stripe le sait `CAPTURED`) | Idem | Replay DLQ ; vérifier scheduler `RECONCILE` |
| `CLOUDINARY` (notification asset) | — *(impact mineur possible — selon implémentation future)* | — | **TODO Design 005B** — pas de route admin DLQ Cloudinary sur `main` (enum DB seul) |

**Règle UX produit** : tant qu'un webhook critique est en DLQ pour une mission donnée, le client/prestataire voit l'état serveur courant **sans incohérence visible** — le scheduler `RECONCILE` détectera et l'admin résoudra. Aucun message d'erreur dédié n'est exposé à l'utilisateur final.

---

## 7. Schedulers & impact UX visible

| Scheduler (`FinanceRunType`) | Visible CLIENT ? | Visible PRESTATAIRE ? | Visible ADMIN ? | Trigger UX |
|---|:-:|:-:|:-:|---|
| `RECONCILE` | ❌ | ❌ | ✅ | Mismatches → admin résout |
| `STUCK` | ❌ | ❌ | ✅ | Mismatches « bloqués » → admin investigue |
| `INVARIANTS` | ❌ | ❌ | ✅ | Mismatches `INVARIANT_SUM` → urgence |
| `REPORT` | ❌ | ❌ | ✅ (email quotidien) | Rapport agrégé |
| `PAYOUT_ANOMALY` | ❌ | ❌ | ✅ | Anomalie payout → instruction |
| `AutoReleaseJob` (BullMQ) | ✅ *(implicite via compteur T+48h)* | ✅ *(implicite via état mission)* | ✅ | Cron de sécurité horaire en plus du delayed job |

---

## 8. Idempotence côté UX

> Conformément à PRD-003 et `payments.errors.ts` (`PaymentIdempotencyConflictException`).

| Action | Clé idempotence | Source | Comportement si replay |
|---|---|---|---|
| Création PaymentIntent | `Idempotency-Key` header (UUID) | Mobile génère ; Stripe + serveur conservent | Replay même clé + même mission → 200 (réponse cachée) ; replay même clé + autre mission → 409 `PAYMENT_IDEMPOTENCY_CONFLICT` |
| Upload photo | `captureClientUuid` (UUID v4 mobile) | Mobile génère lors capture | Replay → 200 idempotent ; UUID différent même fichier → nouveau Photo |
| Webhook Stripe | `stripe_event_id` (table dédiée) | Stripe | Replay → 200 immédiat, traitement skippé |
| Validation mission | (pas d'idempotency-key — état mission garantit unicité) | — | 2e appel après succès → 409 `MISSION_NOT_VALIDATABLE` |
| Report problem | (pas d'idempotency-key) | — | 2e appel → 409 `MISSION_DISPUTE_ALREADY_OPEN` |

**Règle UX produit** : double-clic / re-soumission rapide ne doit **jamais** créer un doublon ou un état corrompu. Le frontend désactive le bouton submit immédiatement et **attend la réponse serveur** avant de réactiver (pas d'optimistic).

---

## 9. Compteur T+48h ouvrées — règles produit

> Source : PRD-003 §4.3, ADR-008, BullMQ delayed job + cron de sécurité.

| Aspect | Règle |
|---|---|
| Fuseau de référence | Europe/Paris (`date-fns-tz`) |
| Jours ouvrés | Lun-Ven hors jours fériés FR (`date-fns-business-days`) |
| Démarrage compteur | `completedAt` mission (passage en `CLIENT_VALIDATION_PENDING`) |
| Annulation compteur | `validate` (succès), `report-problem` (DISPUTE_OPEN) |
| Affichage CLIENT | Compteur dégressif (« plus que XXh YYmin pour valider ») — refresh polling 60s |
| Affichage PRESTATAIRE | « En attente du client » sans compteur précis (pas de pression visible) |
| Affichage ADMIN | Date prévue de capture + statut `AutoReleaseJob` |
| Fallback cron de sécurité | Cron horaire qui rattrape les jobs ratés/perdus (idempotent) |
| Comportement si Payment expire avant T+48h | 422 `PAYMENT_AUTHORIZATION_EXPIRED` ; mission reste `CLIENT_VALIDATION_PENDING` ; admin instruit (rare, < 7j Stripe par défaut) |

---

## 10. Permissions par rôle (RBAC produit)

| Action / Ressource | CLIENT (owner) | CLIENT (autre) | PRESTATAIRE (assigné) | PRESTATAIRE (autre) | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|
| Créer mission | ✅ | ✅ | ❌ | ❌ | ✅ (au nom de) |
| Voir détail mission | ✅ | ❌ (404) | ✅ | ❌ (404) | ✅ |
| Lister `mine` | ✅ (siennes) | — | ❌ | — | — |
| Lister `proposed` | — | — | ✅ (filtrées zone + capabilities) | — | — |
| Accepter mission | ❌ | ❌ | ✅ | ❌ | ❌ |
| Annuler mission | ✅ (avant ACCEPTED) | ❌ | ❌ | ❌ | ✅ (audit) |
| Upload BEFORE/AFTER | ❌ | ❌ | ✅ (`MISSION_PRESTATAIRE_ONLY` sinon) | ❌ | ❌ |
| Compléter mission | ❌ | ❌ | ✅ | ❌ | ❌ |
| Valider mission | ✅ | ❌ | ❌ (`MISSION_CLIENT_ONLY`) | ❌ | ❌ |
| Signaler problème | ✅ (fenêtre `CLIENT_VALIDATION_PENDING`) | ❌ | ❌ | ❌ | ❌ |
| Refund | ❌ | ❌ | ❌ | ❌ | ✅ |
| Voir photos AFTER | ✅ | ❌ | ✅ (les siennes) | ❌ | ✅ |
| Voir photos ORIGINAL | ❌ | ❌ | ❌ | ❌ | ✅ (audit / litige) |
| Voir mismatches finance | ❌ | ❌ | ❌ | ❌ | ✅ |
| Voir DLQ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 11. Liens entre cycles (vue produit MVP)

```
Mission ─────► Payment ─────► PaymentIntent (Stripe) ─────► Webhook ─────► MissionStatus
                  │
                  ├─────► Transfer (Connect Express) ─────► Webhook ──► TransferStatus
                  │
                  └─────► Refund (admin manuel) ────────► Webhook ──► RefundStatus

Mission ─────► PhotoUploadSession ─────► Cloudinary (signed URL) ─────► Photo (synced)
                                                                         │
                                                                         └─► Confirmation côté serveur

Mission ─────► AutoReleaseJob (BullMQ delayed) ─────► Cron de sécurité (filet)

Toutes ressources finance ─────► Scheduler RECONCILE/STUCK/INVARIANTS ─────► FinanceMismatch (admin)
```

---

*Document produit le 2026-05-13. Aligné sur `mission-state.machine.ts`, `payments.errors.ts`, `mission-completion.errors.ts`, `schema.prisma`. Aucun design UI fixé.*
