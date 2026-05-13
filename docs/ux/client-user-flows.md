# UX — Client user flows (mobile)

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md) §4.1 (flow client)
> **Glossaire** : [state-glossary.md](state-glossary.md)
> **State machine** : [mission-lifecycle-map.md](mission-lifecycle-map.md)
>
> Document **doc-only** — flows métier textuels, pas de maquettes graphiques. Boring UX, polling, refresh manuel autorisé partout, pas d'optimistic sur actions financières.

---

## 1. Onboarding client

### 1.1 Cas nominal

```
[Démarrage app]
   │
   ▼
[Splash] ─► no token / token invalide ─► [Login/Signup choice]
                                            │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                       [Signup CLIENT]              [Login email/password]
                              │                           │
                              ▼                           │
                       POST /v1/auth/register             │
                       { role: CLIENT, ... }              │
                              │                           │
                              ▼                           ▼
                       Vérif Zod côté serveur     POST /v1/auth/login
                              │                           │
                              ▼                           ▼
                       201 Created                   200 OK (access + refresh)
                              │                           │
                              ▼                           ▼
                       [Auto-login]               [Home CLIENT]
                              │
                              ▼
                       [Home CLIENT]
```

### 1.2 Données minimales

| Champ | Source | Validation |
|---|---|---|
| `email` | Saisie | Zod email, unique |
| `password` | Saisie | Zod min 12 chars (cf. règle sécu) |
| `firstName` / `lastName` | Saisie | Zod min 1, max 80 |
| `role` | Forcé `CLIENT` | — |
| `address` (optionnelle MVP) | Saisie | À renseigner avant première mission |

### 1.3 Erreurs UX courantes

| Erreur | HTTP | Message UX |
|---|---|---|
| Email déjà utilisé | 409 | « Cet email est déjà utilisé. Connectez-vous ou réinitialisez votre mot de passe. » |
| Mot de passe trop court | 400 (Zod) | « 12 caractères minimum. » |
| Email mal formé | 400 (Zod) | « Format d'email invalide. » |
| Rate limit dépassé | 429 | « Trop de tentatives. Réessayez dans X secondes. » |
| Serveur indisponible | 500/503 | « Service temporairement indisponible. » + retry |

> ⚠️ **MVP** : pas de vérification email obligatoire (`verifiedAt` auto-set). Ouvrable en PRD futur (cf. schema commentaire ligne 282-285).

---

## 2. Création mission (DRAFT → PENDING_PAYMENT)

### 2.1 Flow

```
[Home CLIENT]
   │
   ▼
[Bouton « Nouvelle mission »]
   │
   ▼
[Étape 1 — Type de prestation]
   - SOFA / MATTRESS / TERRACE / TRASH_BINS / CARPET / OTHER
   │
   ▼
[Étape 2 — Adresse intervention]
   - Adresse + coords GPS (géocodage backend)
   │
   ▼
[Étape 3 — Date souhaitée + créneau]
   - DatePicker + slot horaire
   │
   ▼
[Étape 4 — Détail / photos préalables (optionnel)]
   │
   ▼
[Étape 5 — Récap + prix estimé]
   - Affichage estimatedPriceCents (calcul serveur)
   │
   ▼
[Bouton « Payer et publier »]
   │
   ▼
POST /v1/missions ─► 201 (DRAFT créé)
   │
   ▼
POST /v1/payments/intent
   Header: Idempotency-Key: <UUID v4 mobile>
   Body: { missionId }
   │
   ▼
   ┌────────────────────────────────────────┐
   │ 200 → client_secret PaymentIntent      │
   │ Mission status: PENDING_PAYMENT        │
   │ Payment status: AUTHORIZATION_PENDING  │
   └────────────┬───────────────────────────┘
                ▼
   [Stripe PaymentSheet mobile]
                │
                ▼
   ┌───────────────────┬───────────────────┐
   │  ✅ Autorisation   │   ❌ Refus carte  │
   └─────────┬─────────┴────────┬──────────┘
             ▼                  ▼
   Webhook Stripe         Erreur 402 / 422
   `amount_capturable_    Mission reste DRAFT
   updated`               Payment status FAILED
             │
             ▼
   Mission → PUBLISHED
   Payment → AUTHORIZED
             │
             ▼
   [Écran « Mission publiée »]
   « En attente d'un prestataire »
```

### 2.2 Polling pendant `PENDING_PAYMENT`

- TanStack Query `GET /v1/missions/:id` toutes les 5s pendant 30s
- Au-delà → bouton « Actualiser » manuel + message « Toujours en cours »
- Cas particulier : double clic sur « Payer et publier » → l'`Idempotency-Key` est généré **une fois** par mission au début du flow et conservé tant que l'opération n'est pas terminée. Replay = même intent.

### 2.3 États possibles à l'écran

| MissionStatus | Payment | Écran CLIENT |
|---|---|---|
| `DRAFT` | (absent) | Formulaire de création |
| `PENDING_PAYMENT` | `AUTHORIZATION_PENDING` | Attente webhook |
| `PUBLISHED` | `AUTHORIZED` | « Publiée — en attente d'un prestataire » |
| `CANCELLED` (depuis DRAFT) | `CANCELLED` ou absent | « Annulée » |

---

## 3. Mission publiée → acceptée

### 3.1 Flow

```
[Home CLIENT — onglet « Mes missions »]
   │
   ▼
GET /v1/missions/mine ─► liste avec MissionStatus
   │
   ▼
[Carte « Nettoyage canapé — PUBLISHED »]
   - Bouton « Annuler »
   - Polling 30s focus / pause background
   │
   ▼
(Côté serveur) Prestataire matche + POST /:id/accept
   │
   ▼
Mission → ACCEPTED
   │
   ▼
Notification push (PRD-005C — pas MVP)
   │  *** MVP : pas de push — le client voit le changement au refresh ***
   ▼
[Carte mise à jour : « Confirmée — par <Prestataire>  »]
   - Bouton « Annuler »  (transition ACCEPTED → CANCELLED)
   - Date/créneau confirmé
```

### 3.2 Annulation avant intervention

```
[Bouton « Annuler la mission »]
   │
   ▼
[Modal confirmation]
   « Êtes-vous sûr ? Le paiement sera libéré sous 5-10 jours. »
   │
   ▼
DELETE /v1/missions/:id  →  Mission CANCELLED
   │
   ▼
Backend: cancel PaymentIntent Stripe (release authorization)
   │
   ▼
[Écran « Annulée »] + message libération fonds
```

### 3.3 Erreurs

| Cas | HTTP | UX |
|---|---|---|
| Mission déjà acceptée et en cours | 409 | « Impossible d'annuler — contactez le support. » (MVP) |
| Mission déjà CLIENT_VALIDATION_PENDING | 409 | Idem |
| Non owner | 403 | (cas anormal — déconnexion forcée) |
| Mission introuvable | 404 | « Mission introuvable. » |

---

## 4. Upload BEFORE (prestataire) — visibilité côté client

> **MVP** : le client ne voit pas les BEFORE en direct. Décision PRD-005 §10 Q15 — pas de tracking GPS continu. Les BEFORE servent surtout au prestataire et à l'admin (litige).
> 
> Statut visible côté client : mission reste en `ACCEPTED` jusqu'à `/complete`.

---

## 5. Mission en cours (ACCEPTED → CLIENT_VALIDATION_PENDING)

### 5.1 Vue client pendant `ACCEPTED`

```
[Détail mission ACCEPTED]
   - Date confirmée
   - Prestataire (nom court, pas de téléphone direct — MVP)
   - Pas de timer
   - Bouton « Annuler » (jusqu'à `/complete` côté prestataire)
   - Bouton « Signaler un problème » → désactivé jusqu'à CLIENT_VALIDATION_PENDING
```

### 5.2 Bascule vers `CLIENT_VALIDATION_PENDING`

Déclencheur : prestataire appelle `POST /v1/missions/:id/complete` (garde-fou photos serveur : ≥3 BEFORE + ≥5 AFTER syncées).

Côté client (au refresh / polling) :

```
Mission status : ACCEPTED → CLIENT_VALIDATION_PENDING
   │
   ▼
[Écran d'alerte client]
   « Votre prestataire a terminé. Validez sous 48h ouvrées. »
   - Compteur dégressif (refresh 60s)
   - Galerie photos AFTER (≥5)
   - Bouton « Valider et payer »
   - Bouton « Signaler un problème »
   - Bouton « Annuler la mission » (si exposé — **autorisé** par la state machine
     `CLIENT_VALIDATION_PENDING → CANCELLED` via `DELETE /v1/missions/:id` ;
     **décision produit Design 005A** : afficher ou masquer selon politique
     d'annulation + message sur libération autorisation Stripe)
```

---

## 6. Validation finale (CLIENT_VALIDATION_PENDING → COMPLETED)

### 6.1 Flow nominal

```
[Bouton « Valider et payer »]
   │
   ▼
[Modal confirmation]
   « Confirmer la validation libérera <montant> EUR au prestataire. »
   │
   ▼
POST /v1/missions/:id/validate (CLIENT only)
   │  (pas d'idempotency-key — l'état mission garantit unicité)
   │
   ▼
   Backend : Stripe capture PaymentIntent
   Webhook `payment_intent.succeeded` →  Mission COMPLETED
   │
   ▼
[Écran « Mission terminée »]
   - Reçu de paiement (n° Stripe — partiel masqué)
   - Bouton « Noter votre prestataire » → désactivé MVP (PRD-005C)
   - Bouton « Télécharger la facture » → désactivé MVP (PRD-005D)
```

### 6.2 Auto-release fallback (T+48h ouvrées)

Si le client **ne fait rien** dans la fenêtre :
- BullMQ delayed job tire → capture Stripe → `COMPLETED` automatique
- Côté client (au refresh) : « Mission terminée — validation automatique » avec date
- **Pas de notification push MVP** (PRD-005C)

### 6.3 Erreurs `/validate`

| Cas | HTTP | UX |
|---|---|---|
| Mission pas en `CLIENT_VALIDATION_PENDING` | 409 `MISSION_NOT_VALIDATABLE` | « Cette mission n'attend plus de validation. » |
| `Payment` pas en `AUTHORIZED` | 409 `PAYMENT_NOT_CAPTURABLE` | « Paiement non capturable — contactez le support. » |
| Autorisation Stripe expirée (7j) | 422 `PAYMENT_AUTHORIZATION_EXPIRED` | « Autorisation bancaire expirée. Contactez le support. » |
| Non client owner | 403 `MISSION_CLIENT_ONLY` | (cas anormal) |
| Litige déjà ouvert | 409 `MISSION_DISPUTE_ALREADY_OPEN` | Désactivation bouton + bandeau « Litige en cours » |

---

## 7. Signaler un problème (CLIENT_VALIDATION_PENDING → DISPUTE_OPEN)

### 7.1 Flow

```
[Bouton « Signaler un problème »] (visible UNIQUEMENT en CLIENT_VALIDATION_PENDING)
   │
   ▼
[Formulaire report-problem]
   - Catégorie : sale, retard, casse, comportement, autre (MVP minimal)
   - Description libre (min 20 chars, max 2000)
   - Photos additionnelles (optionnel — TODO PRD-005C)
   │
   ▼
POST /v1/missions/:id/report-problem
   │
   ▼
   Backend :
     - Mission → DISPUTE_OPEN
     - Cancel auto-release job (BullMQ)
     - Audit log
   │
   ▼
[Écran « Litige ouvert »]
   « Notre équipe vous contactera sous X heures. »
   - Référence ticket
   - Pas d'action utilisateur supplémentaire MVP
```

### 7.2 Limites MVP

- Pas de chat support intégré → email externe
- Pas d'upload preuves photos (PRD-005C)
- Pas de re-validation possible une fois DISPUTE_OPEN

### 7.3 Erreurs

| Cas | HTTP | UX |
|---|---|---|
| Mission pas en `CLIENT_VALIDATION_PENDING` | 409 | « Impossible de signaler — la mission n'est pas en attente de validation. » |
| Litige déjà ouvert | 409 `MISSION_DISPUTE_ALREADY_OPEN` | « Un litige est déjà ouvert sur cette mission. » |
| Catégorie invalide | 400 `MISSION_REPORT_PROBLEM_BAD_INPUT` | « Choisissez une catégorie valide. » |
| Description trop courte | 400 (Zod) | « 20 caractères minimum. » |

---

## 8. Refund / refus côté client

> Le refund est **déclenché par l'admin**, pas par le client en MVP. Le client voit le résultat passivement.

### 8.1 Cas où le client voit un refund

| Origine | Trigger | État final |
|---|---|---|
| Admin refund post-litige | `POST /v1/admin/payments/:id/refund` | Mission `REFUNDED` (motif visible) |
| Stripe dispute lost | `charge.dispute.closed` | Mission reste `DISPUTE_OPEN` ; refund externe |

### 8.2 Écran « Remboursée »

```
[Détail mission REFUNDED]
   - Bandeau « Remboursée intégralement »
   - Date remboursement
   - Délai d'apparition sur compte : 5-10 jours
   - Motif (optionnel — admin)
   - Pas d'action utilisateur
```

### 8.3 État intermédiaire `REFUND_PENDING`

Côté client (polling) :
- Bandeau « Remboursement en cours »
- Pas d'action utilisateur
- Refresh manuel autorisé

---

## 9. Historique missions

### 9.1 Flow

```
[Onglet « Mes missions »]
   │
   ▼
GET /v1/missions/mine?cursor=&limit=20
   │
   ▼
[Liste paginée (keyset pagination — pas offset)]
   - Filtre par statut (chips : Toutes / En cours / Terminées / Annulées)
   - Tri par date décroissante
   - Pull-to-refresh
```

### 9.2 États affichés

| Filtre UI | Inclut `MissionStatus` |
|---|---|
| Toutes | tous sauf `DRAFT` *(brouillons rangés à part)* |
| Brouillons | `DRAFT` |
| En cours | `PENDING_PAYMENT`, `PUBLISHED`, `ACCEPTED`, `CLIENT_VALIDATION_PENDING` |
| Terminées | `COMPLETED` |
| Annulées | `CANCELLED`, `EXPIRED`, `REFUNDED` |
| Litiges | `DISPUTE_OPEN` |

### 9.3 Détail mission

`GET /v1/missions/:id` — affichage exhaustif. **Photos visibles selon RBAC** :
- `BEFORE` : visible client (variant `DISPLAY` uniquement)
- `AFTER` : visible client (variant `DISPLAY` uniquement)
- `ORIGINAL` : **jamais** visible client (admin/litige)

---

## 10. Erreur paiement

### 10.1 Cartographie

| Erreur backend | HTTP | Code | Message UX | Action UI |
|---|---|---|---|---|
| Mission introuvable | 404 | `MISSION_NOT_FOUND` | « Mission introuvable. » | Retour à la liste |
| Non owner | 403 | `MISSION_FORBIDDEN` | « Accès refusé. » | Déconnexion |
| Mission pas DRAFT | 409 | `PAYMENT_INVALID_STATE` | « Cette mission ne peut plus être payée à nouveau. » | — |
| Replay Idempotency-Key sur autre mission | 409 | `PAYMENT_IDEMPOTENCY_CONFLICT` | « Erreur technique. » | Regénérer clé puis retry |
| Pas de prix calculé | 422 | `PAYMENT_AMOUNT_REQUIRED` | « Estimation manquante. Recommencez. » | Retour étape récap |
| Header Idempotency-Key manquant | 400 | `PAYMENT_MISSING_IDEMPOTENCY_KEY` | « Erreur technique. » | Retry auto |
| Stripe error générique | 422 | `PAYMENT_STRIPE_ERROR` | « Paiement refusé. Essayez une autre carte. » | Retry manuel |
| Autorisation expirée 7j | 422 | `PAYMENT_AUTHORIZATION_EXPIRED` | « Autorisation bancaire expirée. Relancez le paiement. » | Bouton « Relancer paiement » |
| Module désactivé (FF off) | 503 | `PAYMENTS_DISABLED` | « Paiements indisponibles — réessayez plus tard. » | — |

### 10.2 Règles UX paiement

- ❌ **Aucun message Stripe brut** côté UI (Pino redactor + règle sécu)
- ❌ **Pas d'optimistic update** — afficher l'état serveur après confirmation
- ✅ Bouton submit désactivé pendant la requête + spinner
- ✅ Retry autorisé en cas d'erreur réseau (`fetch` failed) mais **même `Idempotency-Key`** tant que pas de réponse 200
- ✅ Nouvelle `Idempotency-Key` uniquement si la mission échoue et que l'utilisateur recommence depuis la récap

---

## 11. Expiration / session timeout

### 11.1 Cas

| Cas | HTTP | Comportement UI |
|---|---|---|
| Token access expiré (15 min) | 401 | Tentative auto refresh ; si refresh OK → retry transparent |
| Refresh token expiré (30j) | 401 | Logout + écran login + message « Reconnectez-vous » |
| Refresh token révoqué | 401 | Idem |
| `PhotoUploadSession` expirée (TTL 5 min) | 410 `PHOTO_UPLOAD_SESSION_EXPIRED` | Retry transparent (nouveau presign) |
| `Idempotency-Key` Stripe expirée (24h) | 422 | Regénérer clé client puis retry |

### 11.2 Flow refresh token (transparent)

```
[Requête HTTP API] ─► 401 access expired
                         │
                         ▼
                  [Intercepteur HTTP]
                         │
                         ▼
                  POST /v1/auth/refresh
                  { refreshToken }
                         │
                  ┌──────┴──────┐
                  ▼             ▼
                 200          401/410
                  │             │
                  ▼             ▼
            Retry requête   Logout forcé
            originale       + écran login
            avec nouveau
            access token
```

### 11.3 Reprise de session après kill app

- TanStack Query rehydrate les caches récents (limites strictes — pas de cache des actions financières)
- Au redémarrage : appel `GET /v1/auth/me` pour valider le token courant
- Si invalide → écran login

---

## 12. Edge cases côté client

| Cas | Comportement |
|---|---|
| Réseau coupé pendant création mission | Erreur réseau + retry manuel (formulaire conservé localement temporairement) |
| Réseau coupé pendant paiement (avant webhook) | Mission reste `DRAFT` ou `PENDING_PAYMENT` — au retour réseau, polling reprend |
| Double clic sur « Valider » | Bouton désactivé pendant requête ; 2e clic ignoré ; en cas de 409 `MISSION_NOT_VALIDATABLE` → l'UI sait que la 1ère a réussi |
| Mission supprimée entre temps (admin) | 404 → message « Mission introuvable » + retour liste |
| Photos AFTER pas encore syncées vues côté client | Compteur « X/5 photos disponibles » — refresh polling |
| Push reçue mais app fermée (PRD-005C MVP : pas applicable) | — |

---

*Document produit le 2026-05-13. Aligné sur routes mergées dans `apps/api/src/modules/`. Pas de UX fancy — boring, robuste, exploitable support.*
