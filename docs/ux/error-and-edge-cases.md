# UX — Erreurs & edge cases (Clean Connect MVP)

> **Statut** : 🧭 *UX Mapping Preparation* (doc-only)
> **PRD pilote** : [PRD-005 Product Experience](../prd/PRD-005-product-experience.md)
> **Source backend** : `apps/api/src/modules/**/*.errors.ts` (Payments, Photos, Mission Completion) + `app.module.ts` filters
> **Glossaire** : [state-glossary.md](state-glossary.md)
>
> Document **doc-only**. Cartographie exhaustive **HTTP status → code métier → message UX → action UI → retry**. Pas de design.

---

## 1. Principes UX d'erreur (boring & explicite)

| Règle | Application |
|---|---|
| **Aucun message Stripe brut** côté UI | Pino redactor + règle sécu + classes d'exceptions filtrent toujours `reason` |
| **Aucun identifiant interne brut** affiché | Pas de `payment_intent_id`, `transfer_id`, `mismatch_id` côté CLIENT/PRESTATAIRE |
| **Code métier stable** dans le body | Champ `error` Zod-validé OpenAPI — utilisé par l'i18n côté front |
| **Aucune erreur générique « Une erreur est survenue »** | Toujours un message actionnable ou un message « contactez le support » avec référence |
| **Pas d'optimistic update sur actions financières** | Toujours afficher l'état serveur après confirmation |
| **Toujours indiquer si retry est sûr** | UI désactive le bouton ou propose explicitement « Réessayer » |
| **Toujours fournir une issue/sortie** | Bouton « Retour », « Recommencer », « Contacter support » |

---

## 2. Mapping global — HTTP → UX

> Tableau de référence. Les codes détaillés (Payments / Photos / Missions / Webhooks / Finance) sont en §3.

| HTTP | Sens générique | Cas typique Clean Connect | Message UX par défaut | Retry autorisé ? |
|---|---|---|---|---|
| **400** | Validation invalide | Zod échoué, MIME refusé, motif manquant | « Données invalides — corrigez puis réessayez » | ✅ après correction |
| **401** | Session expirée / token invalide | Access expired, refresh expired | Refresh transparent ; sinon logout | ✅ auto (refresh) |
| **403** | Accès refusé (RBAC ou ownership) | Cross-mission, mauvais rôle | « Accès refusé » + retour Home | ❌ |
| **404** | Resource introuvable | Mission/photo/user inconnu | « Introuvable » + bouton retour | ❌ |
| **409** | Conflit d'état | Transition interdite, déjà fait, lock busy | Message contextuel + bouton « Refresh » | ❌ (état serveur prime) |
| **410** | Resource expirée (Gone) | Session upload expirée (TTL 5min) | (silencieux — re-presign auto) | ✅ auto |
| **422** | Action métier impossible | Refund partiel, paiement expiré | Message explicite + alternative | Variable (cf. tableau) |
| **429** | Rate limit | Tentatives trop rapides | « Trop de tentatives — patientez » + countdown | ✅ après délai |
| **500** | Erreur serveur inattendue | Bug serveur, DB indisponible | « Erreur technique — réessayez » + référence ticket | ✅ manuel |
| **502 / 503 / 504** | Indisponibilité / FF off / timeout | FF désactivé, dépendance externe down | « Service indisponible — réessayez plus tard » | ✅ manuel (avec délai) |

---

## 3. Mapping détaillé par module

### 3.1 Payments (`apps/api/src/modules/payments/payments.errors.ts`)

| HTTP | Code métier | Cause | Message UX | Action UI | Retry |
|---|---|---|---|---|---|
| 400 | `WEBHOOK_INVALID_SIGNATURE` | Signature webhook KO (côté admin/SRE) | (jamais user — DLQ) | — | — |
| 400 | `WEBHOOK_LIVEMODE_MISMATCH` | Webhook test sur prod | (jamais user — DLQ) | — | — |
| 400 | `WEBHOOK_PAYLOAD_MALFORMED` | Body webhook corrompu | (jamais user — DLQ) | — | — |
| 400 | `PAYMENT_MISSING_IDEMPOTENCY_KEY` | Header `Idempotency-Key` absent | « Erreur technique » | Retry auto avec UUID généré | ✅ auto |
| 404 | `MISSION_NOT_FOUND` | Mission introuvable | « Mission introuvable » | Retour liste | ❌ |
| 403 | `MISSION_FORBIDDEN` | Non owner | « Accès refusé » | Logout forcé | ❌ |
| 409 | `PAYMENT_INVALID_STATE` | Mission pas en DRAFT, PI vivant | « Cette mission ne peut plus être payée à nouveau » | Refresh état | ❌ |
| 409 | `PAYMENT_IDEMPOTENCY_CONFLICT` | Même `Idempotency-Key`, autre missionId | « Erreur technique » | Regénérer clé + retry | ✅ manuel |
| 409 | `PAYMENT_NOT_CAPTURABLE` | Payment ≠ AUTHORIZED au moment du `/validate` | « Paiement non capturable — contactez le support » | Bouton support | ❌ |
| 409 | `PAYMENT_REFUND_BLOCKED_TRANSFER_SENT` | Refund admin alors que transfer envoyé | (admin only) « Transfer prestataire envoyé — traitement manuel Stripe » | Lien Stripe Dashboard | ❌ |
| 422 | `PAYMENT_AMOUNT_REQUIRED` | Mission sans `estimatedPriceCents` | « Estimation manquante — recommencez » | Retour récap | ✅ après MAJ |
| 422 | `PAYMENT_STRIPE_ERROR` | Erreur Stripe générique | « Paiement refusé — essayez une autre carte » | Stripe sheet réouverte | ✅ manuel |
| 422 | `PAYMENT_AUTHORIZATION_EXPIRED` | Autorisation Stripe expirée (7j) | « Autorisation bancaire expirée — relancez le paiement » | Bouton « Relancer paiement » | ✅ avec nouveau intent |
| 422 | `PAYMENT_PARTIAL_REFUND_NOT_SUPPORTED` | Refund partiel admin | (admin only) « Refund intégral uniquement en MVP » | — | ❌ |
| 503 | `PAYMENTS_DISABLED` | `FF_PAYMENTS_ENABLED=false` | « Paiements indisponibles — réessayez plus tard » | — | ✅ après délai |

### 3.2 Photos (`apps/api/src/modules/photos/photos.errors.ts`)

| HTTP | Code métier | Cause | Message UX | Action UI | Retry |
|---|---|---|---|---|---|
| 400 | `PHOTO_MIME_NOT_ALLOWED` | MIME refusé (whitelist) | « Format non supporté (JPEG/PNG/HEIC autorisés) » | Reprendre photo | ❌ pour ce fichier |
| 400 | `PHOTO_MAX_BYTES_EXCEEDED` | > 10 MiB | « Photo trop volumineuse — réduisez la qualité » | Compression côté client | ✅ après recompress |
| 403 | `PHOTO_FORBIDDEN` | Pas le prestataire assigné | « Accès refusé » | — | ❌ |
| 404 | `PHOTO_NOT_FOUND` | Mission inconnue | « Mission introuvable » | Retour | ❌ |
| 409 | `PHOTO_INVALID_STATE` | Mission terminée / état KO | « Upload refusé — mission terminée » | — | ❌ |
| 409 | `PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED` | Session replay (idempotent) | (silencieux — photo déjà sync) | — | ❌ (succès) |
| 409 | `PHOTO_UPLOAD_SESSION_MISSION_MISMATCH` | Session ≠ mission | (cas anormal — alert) | — | ❌ |
| 409 | `PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH` | UUID body ≠ session | (cas anormal — alert) | — | ❌ |
| 410 | `PHOTO_UPLOAD_SESSION_EXPIRED` | Session > 5 min | (silencieux — re-presign auto) | — | ✅ auto |
| 422 | `PHOTO_INVALID_STATE` | Asset Cloudinary absent / mismatch metadata | « Upload incomplet — réessayez » | — | ✅ |
| 503 | `PHOTOS_DISABLED` | `FF_PHOTOS_ENABLED=false` | « Service photos indisponible » | — | ✅ après délai |

### 3.3 Mission completion (`apps/api/src/modules/missions-completion/mission-completion.errors.ts`)

| HTTP | Code métier | Cause | Message UX | Action UI | Retry |
|---|---|---|---|---|---|
| 400 | `MISSION_REPORT_PROBLEM_BAD_INPUT` | Catégorie/description invalide | « Données invalides » | Correction formulaire | ✅ après correction |
| 403 | `MISSION_CLIENT_ONLY` | Acteur pas CLIENT owner | (cas anormal — logout) | — | ❌ |
| 403 | `MISSION_PRESTATAIRE_ONLY` | Acteur pas PRESTATAIRE assigné | (cas anormal — logout) | — | ❌ |
| 409 | `MISSION_NOT_COMPLETABLE` | Mission pas en ACCEPTED | « Mission pas dans le bon état » | Refresh + retour | ❌ |
| 409 | `MISSION_NOT_VALIDATABLE` | Mission pas en CLIENT_VALIDATION_PENDING | « Cette mission n'attend plus de validation » | Refresh | ❌ |
| 409 | `MISSION_PHOTOS_INSUFFICIENT` | < 3 BEFORE ou < 5 AFTER syncées | « Encore X BEFORE / Y AFTER nécessaires » | Galerie + retry uploads | ✅ après uploads |
| 409 | `MISSION_DISPUTE_ALREADY_OPEN` | Litige déjà ouvert | « Un litige est déjà ouvert » | Désactivation bouton | ❌ |

### 3.4 Finance / Admin (`apps/api/src/modules/finance/`)

| HTTP | Code métier | Cause | Message UX (admin) | Action UI | Retry |
|---|---|---|---|---|---|
| 400 | `FINANCE_LIST_MISMATCHES_INVALID_QUERY` | Query Zod invalide (limit, cursor, status, mismatchCode) | « Filtres invalides » | Corriger filtres | ✅ |
| 400 | `FINANCE_INVALID_DATE` | Date `daily-report/:date` mal formée | « Date invalide (YYYY-MM-DD) » | — | ✅ |
| 404 | `FINANCE_MISMATCH_NOT_FOUND` | UUID mismatch inconnu | « Mismatch introuvable » | Retour liste | ❌ |
| 404 | `FINANCE_DAILY_REPORT_NOT_FOUND` | Pas de rapport pour cette date | « Rapport introuvable » | — | ❌ |
| 409 | `FINANCE_RECONCILE_BUSY` | Lock global reconcile occupé (cron ou autre manuel) | « Réconciliation déjà en cours » | Polling | ✅ auto |
| 429 | `FINANCE_MANUAL_RUN_RATE_LIMIT` | Quota runs manuels / admin / 1h glissant dépassé | « Quota atteint — réessayez dans ≤ 1 h » | Countdown | ✅ après délai |
| 409 | `FINANCE_MISMATCH_TRANSITION_INVALID` | Transition statut mismatch interdite | « Transition impossible » + liste `allowed` | Refresh | ❌ |
| 400 | `FINANCE_MISMATCH_NOTES_REQUIRED` | `RESOLVED` / `IGNORED` sans notes ≥ 16 caractères | « Notes obligatoires (≥ 16 caractères) » | Modal notes | ✅ après saisie |
| 503 | *(si guard ajouté en Design)* | `FF_FINANCE_MONITORING_ENABLED=false` sur routes admin | « Module désactivé » | Bandeau | ❌ |

---

## 4. Offline / réseau instable

> Décision PRD-005 §5.11 + §5.12 : **pas d'offline complexe MVP**. Retries explicites, photos retryable, paiements **jamais optimistic**.

### 4.1 Cadre

| Surface | Stratégie |
|---|---|
| TanStack Query (lectures) | Cache court (30s focus / 5min stale) ; refetch on reconnect |
| TanStack Query (mutations) | Pas de persistence des mutations en attente — sauf exception photos |
| Photos | File MMKV dédiée — survit kill app — retry exponentiel |
| Paiements | **Jamais bufférisé** — exige réseau OK pour démarrer |
| Validation mission | Pas de queue — exige réseau OK |
| Création mission | Pas de queue — mais formulaire conservé localement (zustand transient) |

### 4.2 Création mission offline

```
[Utilisateur offline]
   - Formulaire saisi
   - Bouton « Payer et publier » : DÉSACTIVÉ (banner « Connexion requise »)
   - Données conservées en mémoire (zustand) — perdues si kill app
```

**Justification produit** : un paiement bufférisé est dangereux (autorisation Stripe immédiate vs retry différé). MVP refuse. PRD futur peut explorer un brouillon serveur.

### 4.3 Paiement avec réseau instable

```
[Tap « Payer et publier »]
   │
   ▼
POST /payments/intent (timeout 10s)
   │
   ┌────────────────────┬─────────────────┐
   ▼                    ▼                 ▼
   200 OK         Timeout / fetch    402/422
   │              failed              │
   ▼                    ▼              ▼
   Stripe sheet    Retry manuel        Cf. erreurs §3.1
                  AVEC MÊME
                  Idempotency-Key
```

**Règle dure** : tant qu'aucune réponse 2xx/4xx n'est obtenue, le client conserve l'`Idempotency-Key` et peut retry. Une 2xx ou 4xx finale invalide la clé pour cette transaction.

### 4.4 Upload photo timeout

```
[Upload Cloudinary en cours — timeout 30s par tentative]
   │
   ▼
   Erreur réseau → File MMKV : marque entrée pour retry
   │
   ▼
   Schedule retry : 5s → 30s → 2min → 10min → 1h (max 5)
   │
   ▼
   À chaque retry :
   - Si session présign expirée (410) → re-presign
   - Sinon retry PUT Cloudinary direct
```

### 4.5 Confirm upload retry

```
[Cloudinary upload OK mais /confirm n'aboutit pas]
   │
   ▼
   File MMKV conserve l'état « cloudinary_uploaded_not_confirmed »
   │
   ▼
   Retry POST /confirm avec même payload (idempotent côté serveur)
   │
   ▼
   2xx → photo synced
   409 already_consumed → photo déjà synced (idempotent OK)
   404 → mission supprimée entre temps (rare — alerte admin)
```

### 4.6 App kill pendant upload

| État au kill | Comportement au démarrage |
|---|---|
| File MMKV : photo `local_only` | Reprise immédiate du worker |
| File MMKV : photo `uploading_cloudinary` (PUT en cours) | Retry depuis presign (nouveau token car potentiellement expiré) |
| File MMKV : photo `confirm_in_progress` | Retry POST /confirm (idempotent) |
| File MMKV : entrée orpheline (mission supprimée admin) | Worker détecte 404, marque entrée `dead`, alert log côté mobile (vol admin / fraude) |

### 4.7 Reprise session après reconnect

```
[Détection reconnect — NetInfo / Network state]
   │
   ▼
   1. Worker file MMKV reprend
   2. TanStack Query : refetch des queries marquées stale
   3. Bandeau global « De retour en ligne »
   4. Pas d'auto-replay des mutations critiques (paiement, validation)
```

### 4.8 Double tap sur validation

```
[Tap 1 sur « Valider »]
   ─► Bouton désactivé immédiatement
   ─► Spinner
   ─► POST /validate en cours
[Tap 2] → ignoré (bouton déjà désactivé)
   │
   ▼
   Réponse :
     - 200 → succès, redirection écran « Terminée »
     - 409 MISSION_NOT_VALIDATABLE → soit déjà validée (1er tap), soit état changé serveur → refresh + message contextuel
     - 5xx → message « Erreur — réessayez » + réactivation bouton
```

### 4.9 Reconnexion après changement d'état backend

Exemple : prestataire ouvre l'app, mission qu'il consultait est passée `CLIENT_VALIDATION_PENDING` côté serveur (auto-validation ?). Au refresh focus :

```
[Focus app — useFocusEffect]
   │
   ▼
   TanStack Query invalidation + refetch
   │
   ▼
   Détection delta : prev=ACCEPTED, next=CLIENT_VALIDATION_PENDING
   │
   ▼
   Bandeau d'information neutre :
   « L'état de cette mission a changé : <nouveau libellé> »
   Pas de toast intrusif.
```

---

## 5. Edge cases produit (catalogue)

| # | Cas | Comportement attendu |
|---|---|---|
| **E-1** | Mission expirée pendant que client la consultait | Refresh focus → bandeau « Mission expirée » + retour liste sur action |
| **E-2** | Mission acceptée par un autre prestataire pendant que je la lis | 409 sur `/accept` → retour liste + carte disparue |
| **E-3** | Client annule pendant le trajet prestataire | Prestataire au refresh → mission `CANCELLED` + bandeau notification (pas push MVP) |
| **E-4** | Prestataire upload photos après `/complete` | 409 `PHOTO_INVALID_STATE` côté serveur — UI prestataire bloque déjà via état |
| **E-5** | Webhook Stripe arrive 2× (replay) | Idempotent (table `stripe_event_id` unique) — UI ne voit qu'un seul changement |
| **E-6** | Stripe envoie `payment_intent.canceled` après autorisation expirée 7j | Mission/Payment → `CANCELLED` ; client reçoit message « Autorisation expirée — relancez paiement » au refresh |
| **E-7** | Auto-release tire alors que client valide simultanément | 1er gagne (lock DB) ; 2e voit 409 `PAYMENT_NOT_CAPTURABLE` (capture déjà faite) → message UX neutre « Mission déjà validée » |
| **E-8** | Transfer `REVERSED` après `COMPLETED` | Mission → `DISPUTE_OPEN` ; bandeau client + prestataire au refresh |
| **E-9** | Upload partiel : Cloudinary OK mais `confirm` jamais | File MMKV reprend ; `confirm` idempotent → photo synced à la prochaine fenêtre |
| **E-10** | Connexion change réseau pendant upload (WiFi → 4G) | Worker abandonne tentative en cours, reprend depuis presign |
| **E-11** | Token access expiré pile pendant action sensible | Intercepteur refresh transparent + retry une fois |
| **E-12** | Refresh token expiré | Logout forcé + message « Reconnectez-vous » |
| **E-13** | Maintenance mode (FF global) | Bandeau global + lecture seule + boutons critiques désactivés |
| **E-14** | Heure système client décalée (timezone wrong) | Compteur T+48h calculé serveur — affiché serveur (`expiresAt` ISO) ; mobile convertit en local |
| **E-15** | Notifications push (PRD-005C) — pas MVP | Aucun fallback — utilisateur doit refresh manuellement |
| **E-16** | Mismatch finance détecté sur mission en cours | Aucun impact UX user — admin gère ; user voit état serveur courant |
| **E-17** | Scheduler retardé (BullMQ DLQ) | UX user inchangée tant que reconcile rattrape ; admin alerte |
| **E-18** | DLQ Stripe contient un webhook critique non rejoué | UX user **désynchronisée temporairement** (état mission ou paiement obsolète) ; admin replay → reconcile rattrape |
| **E-19** | Conflit état mission entre 2 actions concurrentes | State machine + 409 — l'UI affiche le message contextuel et refresh |
| **E-20** | Photo flag_suspicious (GPS anormal) | Aucun impact direct UX prestataire MVP — admin investigue |

---

## 6. Scheduler retardé / DLQ — impacts UX cartographiés

| Symptôme système | Impact CLIENT | Impact PRESTATAIRE | Impact ADMIN |
|---|---|---|---|
| `STUCK_PENDING` détecté | Aucun (UX neutre) | Aucun | Mismatch `OPEN` dans liste |
| `STUCK_AUTHORIZATION` détecté | Aucun (UX neutre) | Aucun | Mismatch `OPEN` dans liste |
| `STUCK_CAPTURED` (transfer pas créé) | Aucun | « Versement en préparation » prolongé | Mismatch `OPEN` + investigation manuelle |
| DLQ Stripe avec event critique | État mission/payment **figé** côté UI | Idem | Bandeau DLQ + replay manuel |
| Scheduler `RECONCILE` retardé > 1h | Aucun (UX neutre — reconcile rattrape) | Aucun | Alert SRE |
| Daily report `REPORT` échoué | — | — | Email manquant → admin investigue |

---

## 7. Mismatch finance — visibilité côté utilisateur final

> **Règle dure** : un mismatch finance **n'est jamais exposé** au CLIENT ou au PRESTATAIRE.

| Mismatch type | Visible CLIENT ? | Visible PRESTATAIRE ? | Pourquoi |
|---|:-:|:-:|---|
| `STATUS` | ❌ | ❌ | Désync DB/Stripe — admin résout |
| `AMOUNT` | ❌ | ❌ | Idem |
| `CURRENCY` | ❌ | ❌ | Idem |
| `MISSING_DB` | ❌ | ❌ | Idem |
| `MISSING_STRIPE` | ❌ | ❌ | Idem |
| `INVARIANT_SUM` | ❌ | ❌ | Bug métier — admin résout |
| `STUCK_*` | ❌ | ❌ | Délais opérationnels — admin résout |
| `PAYOUT_ANOMALY` | ❌ | ❌ | Anomalie payout — admin résout |

L'UX user voit **uniquement** l'état serveur courant (potentiellement obsolète temporairement) sans alerte technique. Le reconcile corrigera lorsqu'admin résout.

---

## 8. Feature flags & maintenance

### 8.1 FF désactivés visibles

| FF | OFF impact CLIENT | OFF impact PRESTATAIRE | OFF impact ADMIN |
|---|---|---|---|
| `FF_PAYMENTS_ENABLED=false` | Création mission bloquée (503 sur `/payments/intent`) | Toutes missions en cours figées | Bandeau global |
| `FF_PHOTOS_ENABLED=false` | Photos pas visibles | Upload bloqué (503) | Bandeau |
| `FF_FINANCE_MONITORING_ENABLED=false` | Aucun impact direct | Aucun impact direct | Dashboard finance désactivé |

### 8.2 Mode maintenance global futur (placeholder)

PRD futur — pas implémenté MVP. Cf. [admin-operational-flows.md §12.2](admin-operational-flows.md#122-maintenance-mode-global-futur).

UX cible :
- Bandeau global persistant
- Lecture seule majoritaire
- Liste explicite des actions désactivées
- Pas de redirection forcée hors app

---

## 9. Catalogue erreurs additionnelles (côté backend non-métier)

| Source | Comportement |
|---|---|
| Helmet missing CSP headers | Server-side — pas d'impact UX direct |
| CORS bloqué | `fetch` rejected côté mobile → message générique « Erreur de connexion » |
| Rate limit global (`@nestjs/throttler`) | 429 → message countdown |
| Throttle Stripe API | Retry serveur silencieux (BullMQ exponentiel) ; UX user éventuellement « en attente » prolongé |
| Cloudinary indisponible | Retry mobile (offline pattern) + alert admin |
| Resend (email) indisponible | Pas d'impact UX user direct — pas d'email envoyé → DLQ admin |
| FCM (push) — PRD-005C | Hors MVP |

---

## 10. Récapitulatif des principes pour le front (PRD-005A à venir)

1. **Toujours afficher l'état serveur** — pas d'optimistic sur actions financières.
2. **Désactiver immédiatement** les boutons critiques après tap ; ré-activer après réponse.
3. **Conserver l'Idempotency-Key** côté mobile tant qu'aucune réponse 2xx/4xx n'est obtenue.
4. **File MMKV** pour photos uniquement (offline-first photos, online-only paiements/validations).
5. **Refresh manuel autorisé partout** — pas de polling agressif (> 60s en background).
6. **Messages d'erreur explicites** — un message générique = bug UX à corriger.
7. **Toujours fournir une sortie** : retour Home, contact support, ou retry.
8. **Aucun identifiant Stripe brut côté UI** — labels métier uniquement.
9. **Aucun mismatch finance exposé** au CLIENT/PRESTATAIRE.
10. **Aucun délai supposé** côté UI sans donnée serveur (compteur T+48h = `expiresAt` serveur, jamais local).

---

*Document produit le 2026-05-13. Aligné sur `*.errors.ts` mergés sur `main` + règles PRD-005 §5.11/§5.12. Boring, explicite, robuste, exploitable support.*
