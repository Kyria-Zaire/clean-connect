# UX — Glossaire des états back → front

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md) — `DISCOVER_DONE`, Design 005A bloqué §12.2
> **Source de vérité backend** : `apps/api/prisma/schema.prisma` (enums) + `apps/api/src/modules/**/*.errors.ts`
> **Objectif** : transformer chaque état machine du backend en libellé compréhensible utilisateur, par rôle, avec niveau de gravité UX et action attendue. **Aucun design UI**.

---

## Légende

| Symbole | Sens |
|---|---|
| 🟢 | UX neutre — état nominal positif (réussite, action terminée, état stable) |
| 🔵 | UX attente — l'utilisateur attend un événement asynchrone (paiement, validation, scheduler) |
| 🟡 | UX vigilance — quelque chose demande l'attention de l'utilisateur (action requise, presque expiré) |
| 🟠 | UX problème mineur — non bloquant, retry ou contact support possible |
| 🔴 | UX critique — bloquant, support ou admin nécessaire |
| ⚫ | UX terminal — état final, lecture seule |
| 🛡️ | État interne / admin uniquement — JAMAIS exposé au client/prestataire |

> ⚠️ **Pas de palette officielle** : les couleurs « suggérées » sont des indicateurs sémantiques. Le mapping en couleurs CSS sera fixé par le Design System de PRD-005A (cf. PRD-005 §7.3 « Boring UX > fancy »).

---

## 1. `MissionStatus` (enum Prisma `MissionStatus`)

> Source : `schema.prisma` lignes 54-85 + `mission-state.machine.ts` (transitions strictes).

| Code backend | Libellé CLIENT | Libellé PRESTATAIRE | Libellé ADMIN | Description courte | Gravité UX | Badge suggéré | Action utilisateur possible |
|---|---|---|---|---|---|---|---|
| `DRAFT` | « Brouillon » | *(non visible)* | « Brouillon (non publié) » | Mission créée, non encore payée ni publiée | 🟢 nominal | gris | Compléter / supprimer / lancer paiement |
| `PENDING_PAYMENT` | « Paiement en cours… » | *(non visible)* | « Paiement Stripe en cours d'autorisation » | `PaymentIntent` créé, attente webhook `payment_intent.amount_capturable_updated` | 🔵 attente | bleu | Aucune (attendre webhook — refresh manuel autorisé) |
| `PUBLISHED` | « Publiée — en attente d'un prestataire » | « Disponible » | « Publiée » | Mission visible des prestataires éligibles (zone + capabilities) | 🔵 attente | bleu | Client : annuler ; Prestataire : `accept` |
| `PROPOSED` | *(réservé MVP — non utilisé)* | *(réservé MVP — non utilisé)* | « Réservé enum DB » | Enum présent mais flux marketplace via `MissionProposal` | 🛡️ interne | — | Aucune (non rendu en UI) |
| `ACCEPTED` | « Prestataire confirmé » | « Acceptée — à réaliser » | « Acceptée » | Un prestataire a accepté, autorisation Stripe maintenue | 🟢 nominal | vert | Prestataire : upload BEFORE/AFTER puis `complete` ; Client : annuler avant début |
| `IN_PROGRESS` | *(réservé `/start` futur)* | *(réservé `/start` futur)* | « In progress (réservé) » | Enum DB — pas d'endpoint `/start` en MVP (TODO debt) | 🛡️ interne | — | Aucune |
| `CLIENT_VALIDATION_PENDING` | « À valider sous T+48h » | « Terminée — en attente du client » | « Validation client en cours » | Prestataire a appelé `/complete` avec photos suffisantes ; auto-release T+48h ouvrées | 🟡 vigilance (client) / 🔵 attente (prestataire) | orange (client) | Client : `validate` ou `report-problem` ; Prestataire : aucune (sauf litige) |
| `COMPLETED` | « Mission terminée » | « Payée » | « Terminée — payée » | Capture confirmée (`payment_intent.succeeded`) ; transfer Connect séparé (cf. `TransferStatus`) | ⚫ terminal | vert foncé | Client/Prestataire : consulter historique uniquement |
| `DISPUTE_OPEN` | « Litige ouvert — support en cours » | « Litige client — en attente d'instruction » | « DISPUTE_OPEN — instruction » | Litige client (`/report-problem`) ou Stripe `charge.dispute.created` / `transfer.reversed` | 🔴 critique | rouge | Aucune action mobile MVP — instruction admin (PRD-005C/006) |
| `EXPIRED` | « Mission expirée » | « Mission expirée » | « Expirée (TTL publication)" | Mission non acceptée dans la fenêtre — terminal | ⚫ terminal | gris foncé | Lecture seule (créer une nouvelle mission) |
| `CANCELLED` | « Annulée » | « Annulée par client » | « Annulée » | Annulation client (avant ou pendant ACCEPTED) | ⚫ terminal | gris foncé | Lecture seule |
| `REFUNDED` | « Remboursée intégralement » | « Mission remboursée » | « Refundée (intégral) » | Refund ADMIN confirmé (`charge.refunded`) ; transfer NON `SENT` | ⚫ terminal | rouge clair | Lecture seule (motif visible) |

---

## 2. `PaymentStatus` (enum Prisma `PaymentStatus`)

> Source : `schema.prisma` lignes 114-122.

| Code backend | Libellé CLIENT | Libellé ADMIN | Description courte | Gravité UX | Badge suggéré | Action utilisateur |
|---|---|---|---|---|---|---|
| `AUTHORIZATION_PENDING` | « Autorisation bancaire en cours… » | « PI créé (capture_method=manual) — attente webhook » | PaymentIntent créé, en attente `amount_capturable_updated` | 🔵 attente | bleu | Aucune ; UI attend le webhook (timeout doux ~30s avec retry visible) |
| `AUTHORIZED` | « Paiement pré-autorisé — fonds réservés » | « Authorized — capturable » | Fonds bloqués côté banque émettrice ; capturable par le serveur | 🔵 attente | bleu | Aucune ; capture déclenchée par `validate` ou auto-release |
| `CAPTURED` | « Paiement confirmé » | « Capturé » | Capture confirmée (`payment_intent.succeeded`) | 🟢 nominal | vert | Aucune (historique) |
| `REFUND_PENDING` | « Remboursement en cours… » | « Refund admin émis — attente `charge.refunded` » | Refund admin émis, attente confirmation Stripe | 🔵 attente | bleu | Aucune |
| `REFUNDED` | « Remboursée » | « Refunded confirmé » | Webhook `charge.refunded` reçu, refund terminal | ⚫ terminal | rouge clair | Aucune (lecture seule) |
| `FAILED` | « Paiement refusé » | « Failed (raison technique) » | Carte refusée, fonds insuffisants, etc. (sans message Stripe brut) | 🔴 critique | rouge | Reprendre paiement (nouveau intent) |
| `CANCELLED` | « Autorisation annulée » | « Cancelled (manuel ou expiré 7j) » | `payment_intent.canceled` ou autorisation Stripe expirée 7j sans capture | 🟠 problème | orange | Reprendre paiement |

---

## 3. `TransferStatus` (enum Prisma `TransferStatus`)

> Source : `schema.prisma` lignes 130-136. Transfer Connect Express = distinct du paiement carte.

| Code backend | Libellé PRESTATAIRE | Libellé ADMIN | Description courte | Gravité UX | Badge suggéré | Action |
|---|---|---|---|---|---|---|
| `PENDING` | « Versement en préparation » | « Pending (en attente cron transfer) » | Transfer programmé, pas encore envoyé Stripe | 🔵 attente | bleu | Aucune |
| `SENT` | « Versement effectué » | « Sent (idempotent) » | Transfer Stripe envoyé, fonds en cours d'arrivée | 🟢 nominal | vert | Aucune |
| `FAILED` | « Versement échoué — équipe contactée » | « Failed — RETRY_SCHEDULED ou DLQ » | Transfer Stripe échoué (capabilities, KYC, etc.) | 🟠 problème | orange | Aucune côté prestataire ; admin via DLQ |
| `RETRY_SCHEDULED` | « Versement en attente de retry » | « Retry BullMQ exponentiel ≤ 5 tentatives » | Retry programmé après `FAILED` (ADR-008) | 🔵 attente | bleu | Aucune |
| `REVERSED` | « Versement annulé — contactez le support » | « Reversed (Stripe `transfer.reversed`) → mission `DISPUTE_OPEN` » | Transfer repris (compte fermé, fraude) — bascule mission en `DISPUTE_OPEN` | 🔴 critique | rouge | Aucune (admin instruit) |

---

## 4. `RefundStatus` (enum Prisma `RefundStatus`)

> Source : `schema.prisma` lignes 140-144. MVP : refund **intégral uniquement** (`amountCents == Payment.amountCapturedCents`).

| Code backend | Libellé CLIENT | Libellé ADMIN | Description courte | Gravité UX | Badge suggéré | Action |
|---|---|---|---|---|---|---|
| `PENDING` | « Remboursement émis — en attente Stripe » | « Pending (attente webhook `charge.refunded`) » | Refund émis admin, attente confirmation Stripe | 🔵 attente | bleu | Aucune |
| `REFUNDED` | « Remboursée » | « Refunded confirmé » | Webhook `charge.refunded` reçu | ⚫ terminal | vert | Lecture seule |
| `FAILED` | « Remboursement échoué — support averti » | « Failed — instruction manuelle » | Échec Stripe (rare) | 🔴 critique | rouge | Aucune (admin instruit) |

---

## 5. `AutoReleaseJobStatus` (enum Prisma `AutoReleaseJobStatus`)

> Source : `schema.prisma` lignes 166-172. Visible ADMIN uniquement (BullBoard / endpoint dédié si exposé).

| Code backend | Libellé ADMIN | Description courte | Gravité UX | Badge suggéré |
|---|---|---|---|---|
| `SCHEDULED` | « Programmé T+48h ouvrées » | Job BullMQ delayed créé après `/complete` | 🔵 attente | bleu |
| `RUNNING` | « En cours d'exécution » | Cron de sécurité ou job principal en exécution | 🔵 attente | bleu |
| `COMPLETED` | « Auto-release effectuée » | Capture déclenchée par auto-release | 🟢 nominal | vert |
| `CANCELLED` | « Annulé (validation client ou litige) » | Job annulé par `validate` client ou `report-problem` | ⚫ terminal | gris |
| `FAILED` | « Échec auto-release » | Job échoué (DLQ) | 🔴 critique | rouge |

> 🛡️ **Aucun de ces états n'est exposé au client/prestataire**. Le client voit uniquement `CLIENT_VALIDATION_PENDING` avec un compte à rebours.

---

## 6. `FinanceMismatchStatus` (enum Prisma `FinanceMismatchStatus`)

> Source : `schema.prisma` lignes 243-249. **🛡️ ADMIN uniquement.**

| Code backend | Libellé ADMIN | Description courte | Gravité UX |
|---|---|---|---|
| `OPEN` | « Ouvert — non traité » | Mismatch détecté par un scheduler, pas encore vu admin | 🔴 critique |
| `ACKNOWLEDGED` | « Reconnu — sous investigation à venir » | Admin a marqué le mismatch comme « vu », non encore résolu | 🟡 vigilance |
| `INVESTIGATING` | « En investigation » | Admin investigue (notes / liens) | 🟡 vigilance |
| `RESOLVED` | « Résolu » | Cause racine traitée, mismatch fermé | ⚫ terminal (vert) |
| `IGNORED` | « Ignoré (faux positif documenté) » | Mismatch non actionnable (faux positif Stripe, etc.) | ⚫ terminal (gris) |

### Sous-type `FinanceMismatchType`

> Filtres principaux UI admin. Source : `schema.prisma` lignes 214-225. **Aucun de ces codes ne fuit côté CLIENT/PRESTATAIRE.**

| Code backend | Libellé ADMIN | Origine | Gravité par défaut |
|---|---|---|---|
| `STATUS` | « Désynchro statut DB/Stripe » | Scheduler RECONCILE | 🔴 |
| `AMOUNT` | « Montant ≠ DB/Stripe » | Scheduler RECONCILE | 🔴 |
| `CURRENCY` | « Devise ≠ DB/Stripe » | Scheduler RECONCILE | 🔴 |
| `MISSING_DB` | « Présent Stripe, absent DB » | Scheduler RECONCILE | 🔴 |
| `MISSING_STRIPE` | « Présent DB, absent Stripe » | Scheduler RECONCILE | 🔴 |
| `INVARIANT_SUM` | « Invariant montant violé » | Scheduler INVARIANTS | 🔴 |
| `STUCK_PENDING` | « Bloqué en pending > seuil » | Scheduler STUCK | 🟡 |
| `STUCK_AUTHORIZATION` | « Authorization > seuil sans capture » | Scheduler STUCK | 🟡 |
| `STUCK_CAPTURED` | « Captured sans transfer > seuil » | Scheduler STUCK | 🟡 |
| `PAYOUT_ANOMALY` | « Anomalie payout » | Scheduler PAYOUT_ANOMALY | 🟡 |

---

## 7. `ProviderPayoutStatus` (enum Prisma `ProviderPayoutStatus`)

> Source : `schema.prisma` lignes 155-162. Filtre matching strict (PRD-003 Discover Q7).

| Code backend | Libellé PRESTATAIRE | Libellé ADMIN | Description courte | Gravité UX | Action utilisateur |
|---|---|---|---|---|---|
| `NOT_ONBOARDED` | « Activez vos paiements » | « Pas commencé Connect » | Pas de `stripeAccountId` ou aucun onboarding tenté | 🟡 vigilance | Lancer onboarding Connect |
| `ONBOARDING_IN_PROGRESS` | « Continuez votre inscription Stripe » | « Onboarding partiel » | `AccountLink` consommé partiellement | 🟡 vigilance | Reprendre onboarding |
| `IDENTITY_PENDING` | « Document d'identité requis » | « KYC pending » | `requirements.currently_due` non vide côté Stripe | 🟡 vigilance | Fournir KYC |
| `PAYOUTS_DISABLED` | « Versements suspendus — vérifiez vos infos » | « Payouts disabled » | `payouts_enabled=false` | 🔴 critique | Vérifier Stripe |
| `CHARGES_DISABLED` | « Compte suspendu — contactez le support » | « Charges disabled » | `charges_enabled=false` | 🔴 critique | Support |
| `READY` | « Prêt à recevoir des missions » | « Ready (Connect complet) » | Capabilities complètes | 🟢 nominal | Aucune |

---

## 8. Photos — état dérivé (pas d'enum dédié)

> Source : `Photo` et `PhotoUploadSession` (`schema.prisma` lignes 661-766). Le « statut » est **dérivé** :
> - `synced` = `Photo.syncedAt IS NOT NULL`
> - `session active` = `PhotoUploadSession.consumedAt IS NULL AND expiresAt > NOW()`
> - `session expirée` = `expiresAt < NOW()` (TTL 5 min — HTTP 410 GONE)
> - `session consumed` = `consumedAt IS NOT NULL` (HTTP 409 CONFLICT)

### États UX dérivés côté mobile

| État UX local | Description | Gravité UX | Libellé PRESTATAIRE | Action |
|---|---|---|---|---|
| `local_only` | Photo capturée, en file MMKV, pas encore syncée | 🟡 vigilance | « En attente d'envoi » | Retry auto (file MMKV) |
| `presign_in_progress` | Presign en cours (request HTTP) | 🔵 attente | « Préparation… » | Aucune |
| `uploading_cloudinary` | Upload vers Cloudinary en cours | 🔵 attente | « Envoi en cours… » (progress %) | Annuler / pause selon réseau |
| `confirm_in_progress` | `POST /confirm` en cours | 🔵 attente | « Finalisation… » | Aucune |
| `synced` | `syncedAt` renseigné côté serveur | 🟢 nominal | « Envoyée » | Aucune (consultable) |
| `failed_retry_queued` | Échec ≤ 5 retries restants | 🟠 problème | « Échec — nouvelle tentative » | Aucune (retry auto) |
| `failed_exhausted` | 5 retries épuisés | 🔴 critique | « Impossible d'envoyer — réessayez » | Bouton retry manuel |
| `session_expired_410` | Session expirée (HTTP 410) | 🟠 problème | « Reprise nécessaire » | Re-presign + re-upload (automatique) |

### Phase / Variant

| `PhotoType` | Libellé PRESTATAIRE | Min requis pour `/complete` |
|---|---|---|
| `BEFORE` | « Photo avant » | ≥ 3 syncées |
| `AFTER` | « Photo après » | ≥ 5 syncées |

| `PhotoVariant` | Description | Visible utilisateur |
|---|---|---|
| `ORIGINAL` | Conservé sécurisé (audit / litige) | Non |
| `DISPLAY` | EXIF strip + optimisé | Oui (preview / litige UI) |

---

## 9. `FinanceRunStatus` & `FinanceRunType`

> 🛡️ **Admin uniquement** — visible dans `/v1/admin/finance/runs/manual` et endpoints futurs (cf. Admin operational flows).

| `FinanceRunStatus` | Libellé ADMIN | Gravité UX |
|---|---|---|
| `RUNNING` | « En cours » | 🔵 attente |
| `COMPLETED` | « Terminé » | 🟢 nominal |
| `FAILED` | « Échec — voir `failureMessage` » | 🟠 problème |

| `FinanceRunType` | Libellé ADMIN | Fréquence |
|---|---|---|
| `RECONCILE` | « Reconciliation DB ↔ Stripe » | Cron + manuel |
| `STUCK` | « Détection bloqués » | Cron |
| `INVARIANTS` | « Vérification invariants finance » | Cron |
| `REPORT` | « Génération rapport quotidien » | Cron quotidien |
| `PAYOUT_ANOMALY` | « Détection anomalies payout » | Cron |

---

## 10. `StripeWebhookProcessingStatus`

> 🛡️ **Admin uniquement** — visible via outils observabilité ou table d'audit.

| Code | Libellé ADMIN | Gravité UX |
|---|---|---|
| `PENDING` | « En file » | 🔵 attente |
| `PROCESSING` | « Verrouillé pour traitement » | 🔵 attente |
| `PROCESSED` | « Traité (succès idempotent) » | 🟢 nominal |
| `FAILED` | « Échec — DLQ » | 🟠 problème |

---

## 11. Règles produit transversales

### Confidentialité des libellés

- ❌ **Aucun message Stripe brut** côté UI (rule sécurité + Pino redactor). Si une erreur Stripe doit être affichée, c'est via un libellé générique (« Carte refusée », « Vérifiez vos infos bancaires »).
- ❌ **Aucun code mismatch finance** visible côté CLIENT/PRESTATAIRE — uniquement ADMIN.
- ❌ **Aucun identifiant Stripe (`pi_*`, `tr_*`, `re_*`)** affiché aux utilisateurs ; uniquement aux admins avec lien direct vers Stripe Dashboard si pertinent.

### Refresh manuel vs polling

Conformément à PRD-005 §5.11.4 (« Polling > realtime ») :
- Les **états d'attente** (`PENDING_PAYMENT`, `AUTHORIZATION_PENDING`, `REFUND_PENDING`, `TransferStatus=PENDING`) sont **refreshés par polling TanStack Query** (intervalle typique 5-15 s en focus, pause en background).
- **Pas de WebSocket / push** en MVP 005A/005B.
- **Pas d'optimistic update sur les actions financières** : toujours afficher l'état serveur après confirmation.

### Boring UX

Couleurs, icônes, animations seront **figées par le Design System de PRD-005A** une fois les gates §12.2 franchies. Le présent document ne fixe que la **sémantique** (gravité, action attendue, rôle destinataire).

---

*Glossaire produit le 2026-05-13 — branche `docs/ux-mapping-prd-005-pre-design`. Aligné sur enums Prisma + classes d'exceptions NestJS mergées sur `main`.*
