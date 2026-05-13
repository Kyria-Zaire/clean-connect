# UX — Prestataire user flows (mobile)

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md) §4.2 (flow prestataire)
> **Glossaire** : [state-glossary.md](state-glossary.md)
> **State machine** : [mission-lifecycle-map.md](mission-lifecycle-map.md)
>
> Document **doc-only**. Flows métier textuels — pas de maquettes. Focus sur idempotence upload, validation manuelle, pas de tracking GPS continu.

---

## 1. Onboarding prestataire

### 1.1 Vue d'ensemble

```
[Démarrage app] ─► [Login/Signup]
                         │
                         ▼
              [Signup PRESTATAIRE]
                         │
                         ▼
              POST /v1/auth/register { role: PRESTATAIRE, ... }
                         │
                         ▼
              [Setup profil prestataire]
                  - Adresse base (matching)
                  - Rayon intervention km (default 15, max 30)
                  - Types prestations habilité (multi-select)
                         │
                         ▼
              [Onboarding Stripe Connect Express]
                  POST /v1/connect/account-link
                  → URL Stripe externe (WebView ou navigateur système)
                         │
                         ▼
                  [Stripe Connect Form externe]
                  - SIRET / IBAN / pièce identité
                         │
                         ▼
              Retour app via deep link
                         │
                         ▼
              Webhook Stripe `account.updated`
                  → ProviderPayoutStatus mise à jour
                         │
                         ▼
              [Home PRESTATAIRE]
                  - ProviderPayoutStatus visible
                  - Filtre matching basé dessus
```

### 1.2 États `ProviderPayoutStatus` visibles sur Home

> Cf. [state-glossary.md §7](state-glossary.md#7-providerpayoutstatus-enum-prisma-providerpayoutstatus).

| ProviderPayoutStatus | Bandeau Home | Action utilisateur |
|---|---|---|
| `NOT_ONBOARDED` | « Activez vos paiements pour recevoir des missions » | « Lancer onboarding » → AccountLink |
| `ONBOARDING_IN_PROGRESS` | « Continuez votre inscription » | « Reprendre » → AccountLink |
| `IDENTITY_PENDING` | « Document d'identité requis » | « Ouvrir Stripe » |
| `PAYOUTS_DISABLED` | « Versements suspendus — vérifiez vos infos » | « Ouvrir Stripe » |
| `CHARGES_DISABLED` | « Compte suspendu — contactez le support » | Support |
| `READY` | (rien — accès complet) | — |

### 1.3 Filtre matching

Tant que `ProviderPayoutStatus ≠ READY` :
- Onglet « Missions disponibles » **vide** (filtré côté backend)
- Bouton « Accepter une mission » **désactivé**

---

## 2. Acceptation mission

### 2.1 Flow

```
[Home PRESTATAIRE — onglet « Missions disponibles »]
   │
   ▼
GET /v1/missions/proposed
   - Filtre serveur : zone PostGIS + capabilities + statut READY + types acceptés
   │
   ▼
[Liste paginée — boring : carte par mission]
   - Adresse approximative (zone, pas adresse exacte avant accept)
   - Date / créneau
   - Type prestation
   - Prix prestataire (montant - commission 18%)
   - Distance estimée
   │
   ▼
[Tap carte] ─► [Détail mission]
                  - Mêmes infos
                  - Bouton « Accepter cette mission »
                  - Bouton « Refuser » (= pas d'action, retour liste)
   │
   ▼
[Modal confirmation]
   « Acceptez-vous cette mission pour le <date> ? »
   │
   ▼
POST /v1/missions/:id/accept
   │  (pas d'idempotency-key — état mission garantit unicité)
   │
   ▼
   ┌────────────────────┬──────────────────┐
   │   200 OK           │  409 Conflict    │
   └────────┬───────────┴────────┬─────────┘
            ▼                    ▼
   Mission ACCEPTED       « Mission déjà acceptée par un
   Adresse exacte         autre prestataire ou annulée »
   débloquée                       │
            │                       ▼
            ▼                Retour liste
   [Détail mission ACCEPTED]
   - Adresse complète + bouton « Itinéraire »
   - Téléphone client : MASQUÉ MVP
   - Bouton « Démarrer la mission » → côté UX seulement
     (pas d'endpoint /start MVP — cf. TODO debt mission-state.machine.ts)
```

### 2.2 Pourquoi pas d'endpoint `/start` ?

Décision PRD-003 — la transition `ACCEPTED → IN_PROGRESS` n'existe pas serveur en MVP. Le prestataire passe **directement** de `ACCEPTED` à `CLIENT_VALIDATION_PENDING` via `/complete` après avoir uploadé ses photos.

> ✍️ *Pour le Design 005A* : l'état UI « démarrée » peut être **dérivé localement** côté mobile (preference MMKV `mission:{id}:startedAt`) sans toucher au backend. À trancher en Design.

### 2.3 Erreurs

| Cas | HTTP | UX |
|---|---|---|
| Mission déjà acceptée (concurrence) | 409 | « Cette mission a déjà été prise. » + retour liste |
| Mission expirée / annulée | 409 | « Mission plus disponible. » |
| Provider pas READY | 403 | « Activez vos paiements. » + lien onboarding |
| Provider hors zone | 403 | « Mission hors de votre zone. » |
| Mission introuvable | 404 | « Mission introuvable. » |

---

## 3. Upload BEFORE / AFTER (offline-first)

### 3.1 Cadre général

> Source : règle skill `offline-sync-pattern` + `photos.errors.ts`.

Règles dures :
- **Capture côté client** (caméra in-app)
- **Compression** : 1600px max, JPEG qualité 75 (≈ 150-300 KB / photo)
- **UUID v4 client** (`captureClientUuid`) généré localement → clé d'idempotence
- **Variants ORIGINAL + DISPLAY** : 2 presigns + 2 uploads + 2 confirms avec **même** `captureClientUuid`
- **File MMKV** persistante : photos en attente d'envoi survivent au kill app
- **Retry exponentiel** : 5s, 30s, 2min, 10min, 1h (max 5 tentatives)
- **Démarrage mission autorisé** sans photos BEFORE syncées — mais `/complete` **bloque** jusqu'à sync ≥ 3 BEFORE + ≥ 5 AFTER

### 3.2 Flow upload nominal (1 photo)

```
[Caméra in-app]
   │
   ▼
[Capture photo + compression locale]
   - UUID v4 généré (captureClientUuid)
   - File MMKV : enqueue 2 entrées (ORIGINAL + DISPLAY)
   │
   ▼
[Worker file MMKV — boucle retry]
   │
   ▼
POST /v1/missions/:id/photos/presign
   Body: { phase, variant, captureClientUuid, mimeType, bytes }
   Header: Authorization: Bearer <access>
   │
   ▼
   ┌─────────────────────┬────────────────────┐
   │   200 OK            │   Erreur (cf 3.5)  │
   │   {uploadUrl,       │                    │
   │    publicId,        │                    │
   │    token, exp}      │                    │
   └────────┬────────────┴────────────────────┘
            ▼
   PUT uploadUrl (Cloudinary signed URL)
   Body: bytes photo
            │
            ▼
   ┌─────────────────────┬────────────────────┐
   │  200 OK Cloudinary  │   Erreur réseau    │
   └────────┬────────────┴────────┬───────────┘
            ▼                     ▼
   POST /v1/missions/:id/photos/confirm   Retry exponentiel
   Body: {captureClientUuid, publicId,    selon politique
          variant, checksum, ...}
            │
            ▼
   ┌─────────────────────┬────────────────────┐
   │  200 OK             │   Erreur (cf 3.5)  │
   │  syncedAt: <iso>    │                    │
   └────────┬────────────┴────────────────────┘
            ▼
   Photo `synced` ← état UX = ✅
   File MMKV : remove entrée
```

### 3.3 UI prestataire pendant upload

```
[Galerie BEFORE / AFTER]
   - Onglets : BEFORE (X/3 min) | AFTER (Y/5 min)
   - Chaque vignette avec état UX (cf. glossary §8) :
       🟡 local_only           — « En attente d'envoi »
       🔵 presign_in_progress  — « Préparation… »
       🔵 uploading_cloudinary — barre de progression
       🔵 confirm_in_progress  — « Finalisation… »
       🟢 synced               — « Envoyée »
       🟠 failed_retry_queued  — « Nouvelle tentative dans Xs »
       🔴 failed_exhausted     — bouton « Réessayer manuellement »
       🟠 session_expired_410  — bandeau silencieux (re-presign auto)
   - Bouton « Réessayer toutes » global
   - Bouton « Reprendre photo » par vignette
```

### 3.4 Démarrage mission sans BEFORE syncées

```
[Détail mission ACCEPTED]
   - 0 photos BEFORE syncées
   - Bouton « Démarrer mission » (UI seulement, pas d'endpoint)
   │
   ▼
[Workflow prestataire entamé localement]
   - Capture BEFORE → file MMKV → upload différé OK
   - Capture AFTER → file MMKV → upload différé OK
```

**Règle dure backend** : `/complete` rejette tant que `BEFORE < 3` ou `AFTER < 5` syncées.

### 3.5 Erreurs upload (mapping)

| Cas | HTTP | Code | UX prestataire | Retry ? |
|---|---|---|---|---|
| Module désactivé | 503 | `PHOTOS_DISABLED` | « Service photos indisponible. » | Non — bloquant |
| Mission introuvable | 404 | `PHOTO_NOT_FOUND` | « Mission introuvable. » | Non |
| Pas le prestataire assigné | 403 | `PHOTO_FORBIDDEN` | « Accès refusé. » | Non |
| Mission pas dans bon état | 409 | `PHOTO_INVALID_STATE` | « Mission terminée — upload refusé. » | Non |
| Session expirée 5min | 410 | `PHOTO_UPLOAD_SESSION_EXPIRED` | (silencieux — re-presign auto) | Oui auto |
| Session déjà consommée | 409 | `PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED` | (silencieux — idempotent OK) | Non (déjà sync) |
| Mission ≠ session | 409 | `PHOTO_UPLOAD_SESSION_MISSION_MISMATCH` | (cas anormal) | Non |
| `captureClientUuid` mismatch | 409 | `PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH` | (cas anormal) | Non |
| MIME refusé | 400 | `PHOTO_MIME_NOT_ALLOWED` | « Format non supporté. » | Non |
| Trop volumineux | 400 | `PHOTO_MAX_BYTES_EXCEEDED` | « Photo trop volumineuse (>10 MiB). » | Non |
| Cloudinary asset absent | 422 | `PHOTO_INVALID_STATE` | « Upload incomplet — réessayez. » | Oui |
| `cloudinaryPublicId` mismatch | 422 | `PHOTO_INVALID_STATE` | (cas anormal) | Non |
| Metadata mismatch (bytes / MIME) | 422 | `PHOTO_INVALID_STATE` | « Erreur de transmission. » | Oui |
| Rate limit | 429 | — | « Trop d'uploads simultanés. Attendez. » | Backoff |
| Token expiré | 401 | — | Refresh transparent puis retry | Oui auto |

### 3.6 Photos manquantes & complétion

| BEFORE | AFTER | Bouton `/complete` | Message |
|---|---|---|---|
| < 3 | * | Désactivé | « Encore X photos BEFORE nécessaires » |
| ≥ 3 | < 5 | Désactivé | « Encore Y photos AFTER nécessaires » |
| ≥ 3 | ≥ 5 (toutes synced) | Activé | « Terminer la mission » |
| ≥ 3 | ≥ 5 (certaines non synced) | Désactivé | « Attente envoi de Z photos » |

---

## 4. Géolocalisation ponctuelle

> Décision PRD-005 §10 Q15 — **pas de tracking GPS continu** MVP. Géoloc utilisée uniquement aux moments stratégiques.

### 4.1 Points de capture GPS

| Événement | GPS requis ? | Stockage | Utilité |
|---|---|---|---|
| Capture photo BEFORE | Optionnel (best effort) | `Photo.gps_*` | Anti-fraude photo |
| Capture photo AFTER | Optionnel (best effort) | `Photo.gps_*` | Anti-fraude photo |
| Acceptation mission | Non | — | — |
| `/complete` | Non | — | — |

### 4.2 Si GPS refusé

- Champ `Photo.gps_missing = true`
- Côté admin : photo `flag_suspicious = true` possible (logique métier ouverte)
- Côté prestataire : pas de blocage en MVP — message neutre « GPS désactivé »

### 4.3 Permissions UX

```
[Première capture photo]
   │
   ▼
[Demande permission GPS native]
   « Clean Connect souhaite accéder à votre position pour
     les photos avant/après. »
   │
   ▼
   ┌─────────────┬──────────────┐
   ▼             ▼              ▼
   Allow      Allow once    Deny
   │             │              │
   └─────┬───────┘              ▼
         ▼                Photo capturée
   GPS attaché à         sans GPS — neutre
   Photo (lat/lng/acc)
```

---

## 5. Compléter la mission (`/complete`)

### 5.1 Flow

```
[Détail mission ACCEPTED — ≥3 BEFORE + ≥5 AFTER synced]
   │
   ▼
[Bouton « Terminer la mission »]
   │
   ▼
[Modal confirmation]
   « Confirmez que la prestation est terminée. Le client
     dispose de 48h ouvrées pour valider. »
   │
   ▼
POST /v1/missions/:id/complete
   │
   ▼
   ┌─────────────────────────────────┬─────────────────────────┐
   │  200 OK                         │  Erreur (cf 5.3)        │
   │  Mission CLIENT_VALIDATION_     │                         │
   │    PENDING                      │                         │
   │  AutoReleaseJob SCHEDULED       │                         │
   │  (T+48h ouvrées)                │                         │
   └────────────┬────────────────────┴─────────────────────────┘
                ▼
   [Écran « Mission en attente du client »]
   - Bandeau « Validation client en cours »
   - Pas de timer visible côté prestataire (décision UX produit)
   - Lecture seule sur les photos
   - Liste actions désactivées (pas de re-upload, pas de cancel)
```

### 5.2 Pourquoi pas de timer côté prestataire ?

Décision PRD-005 §4.2 — éviter de mettre la pression sur le client par procuration. Le prestataire sait juste « en attente du client » sans compteur précis.

### 5.3 Erreurs `/complete`

| Cas | HTTP | Code | UX |
|---|---|---|---|
| Mission pas en `ACCEPTED` | 409 | `MISSION_NOT_COMPLETABLE` | « Mission pas dans le bon état. » + retour Home |
| Pas le prestataire assigné | 403 | `MISSION_PRESTATAIRE_ONLY` | (cas anormal) |
| Photos insuffisantes | 409 | `MISSION_PHOTOS_INSUFFICIENT` | « Encore X BEFORE / Y AFTER manquantes » + galerie |
| Litige déjà ouvert (rare) | 409 | `MISSION_DISPUTE_ALREADY_OPEN` | Bandeau litige |

---

## 6. États paiement côté prestataire

### 6.1 Pendant `ACCEPTED` / `CLIENT_VALIDATION_PENDING`

- `Payment` est en `AUTHORIZED` — fonds réservés mais non capturés
- **Visible côté prestataire** : montant net (après commission 18 %)
- **Pas de bouton « relancer »** — c'est au client/système

### 6.2 Bascule `COMPLETED`

| Étape | TransferStatus | UX prestataire |
|---|---|---|
| Mission `COMPLETED`, transfer pas encore créé | (absent) | « Mission payée — versement en préparation » |
| Transfer `PENDING` | `PENDING` | « Versement en préparation » |
| Transfer `SENT` | `SENT` | « Versement effectué » + estimation J+1 à J+5 |
| Transfer `FAILED` | `FAILED` | « Versement échoué — équipe contactée » |
| Transfer `RETRY_SCHEDULED` | `RETRY_SCHEDULED` | « Nouvelle tentative en cours » |
| Transfer `REVERSED` | `REVERSED` | « Versement annulé — contactez le support » + mission `DISPUTE_OPEN` |

### 6.3 Mission « bloquée » côté prestataire

Cas où le prestataire **ne peut rien faire** mais voit l'état :

| MissionStatus | Cause | UX prestataire |
|---|---|---|
| `CLIENT_VALIDATION_PENDING` (T+24h sans validation) | Client lent | « En attente du client » (pas de timer) |
| `DISPUTE_OPEN` (depuis `report-problem`) | Client a signalé | « Litige client — équipe en cours d'instruction » |
| `DISPUTE_OPEN` (depuis `transfer.reversed`) | Stripe reverse | « Versement annulé — support » |

---

## 7. Refus validation client → DISPUTE_OPEN

### 7.1 Réception (passive)

Côté prestataire (au refresh) :
```
Mission status : CLIENT_VALIDATION_PENDING → DISPUTE_OPEN
   │
   ▼
[Détail mission DISPUTE_OPEN]
   - Bandeau rouge « Litige client ouvert »
   - Catégorie du litige (visible MVP — boring : juste l'enum, pas la description)
   - Pas d'action utilisateur MVP
   - Message « L'équipe support vous contactera »
```

### 7.2 Limites MVP

- Pas de réponse prestataire intégrée (PRD-005C/006)
- Pas de chat support
- Email externe pour preuves

---

## 8. Historique missions prestataire

### 8.1 État des routes API (MVP actuel)

| Besoin UX | Route existante | Rôle |
|---|---|---|
| Missions proposées (matching) | `GET /v1/missions/proposed` | `PRESTATAIRE` uniquement |
| Détail d’une mission connue | `GET /v1/missions/:id` | `CLIENT`, `PRESTATAIRE`, `ADMIN` (RBAC dans le service) |
| Liste « toutes mes missions assignées » | **Absente** sur `main` | — |

> **TODO Design 005A (contrat API)** : exposer `GET /v1/missions/assigned` (ou étendre `mine` avec RBAC prestataire) pour lister les missions où `prestataireId = user.id` avec pagination keyset — **sans ce contrat**, l’UI « Mes missions » prestataire ne peut s’appuyer que sur un cache local (IDs récents) + deep links, ce qui est **insuffisant** pour un historique complet.

### 8.2 Flow cible (après contrat Design 005A)

```
[Onglet « Mes missions » PRESTATAIRE]
   │
   ▼
GET /v1/missions/assigned  ← **à concevoir**
   │
   ▼
[Liste keyset paginée]
   - Filtres : Toutes / En cours / Terminées / Annulées / Litiges
   - Tri par date décroissante
```

### 8.3 Contournement documentaire avant Design 005A

- Conserver en **MMKV** la liste des `missionId` acceptés / complétés (append-only).
- Au focus Home : `Promise.all(ids.map(id => GET /missions/:id)))` avec plafond (ex. 20) pour éviter tempête réseau.
- Afficher bandeau « Historique partiel — synchronisation en cours » si > plafond.

### 8.4 Détail mission terminée

```
[Détail mission COMPLETED]
   - Photos BEFORE/AFTER (DISPLAY uniquement)
   - Montant net reçu
   - TransferStatus actuel (PENDING/SENT/FAILED/REVERSED)
   - Date capture client
   - Pas de bouton « contact client »
```

---

## 9. Support placeholder

> MVP : **pas de support intégré**. Contact via email externe.

### 9.1 Écran « Aide & Support »

```
[Menu profil → Aide]
   │
   ▼
[Liste de FAQ statiques]
   - Comment activer mes paiements ?
   - Comment uploader mes photos ?
   - Que faire si un client signale un problème ?
   - Quand suis-je payé ?
   │
   ▼
[Bouton « Contacter l'équipe »]
   ─► Email externe (mailto:) — pas de chat MVP
   ─► Référence support pré-remplie (mission ID si pertinent)
```

### 9.2 Cas spécifiques

| Situation | Action UX |
|---|---|
| Mission `DISPUTE_OPEN` | Bouton « Contacter le support à propos de ce litige » → email pré-rempli |
| Transfer `REVERSED` ou `FAILED` | Bouton « Contacter au sujet de mon versement » |
| Compte `PAYOUTS_DISABLED` ou `CHARGES_DISABLED` | Bouton « Contacter au sujet de mon compte » |

---

## 10. Edge cases prestataire

| Cas | Comportement UX |
|---|---|
| Acceptation simultanée 2 prestataires | Le 1er gagne (409 pour le second) ; le second retourne à la liste sans état pollué |
| App killée pendant upload Cloudinary | File MMKV reprend au démarrage ; retry exponentiel |
| Photo capturée hors connexion | File MMKV ; upload différé au retour réseau |
| Refus permission GPS | Photo `gps_missing=true` — pas de blocage MVP |
| Tap rapide « Accepter » 2× | Désactivation immédiate du bouton + 2e tap → 409 « Déjà accepté » |
| Session photo expirée 5min (slow upload) | Re-presign auto silencieux + retry upload (même `captureClientUuid`) |
| Token access expiré pendant `/complete` | Refresh transparent + retry une fois |
| `/complete` réussit mais réseau coupe avant la réponse | Polling `GET /missions/:id` au refresh — si `CLIENT_VALIDATION_PENDING` → succès |
| `ProviderPayoutStatus` change en cours (webhook account.updated) | Bandeau Home se met à jour au prochain focus ; pas de notification push MVP |

---

*Document produit le 2026-05-13. Aligné sur `photos.errors.ts`, `mission-completion.errors.ts`, `mission-state.machine.ts`, schema Prisma. Boring UX — offline robust, pas de tracking continu.*
