# ADR-009 — Photos AVANT/APRÈS : Cloudinary signed upload, dual variant ORIGINAL/DISPLAY, EXIF strip, GPS séparé

> **ADR** = *Architecture Decision Record*.

---

## Métadonnées

| Champ | Valeur |
|---|---|
| **ID** | `ADR-009` |
| **Titre** | Storage photos Clean Connect — Cloudinary signed upload + 2 variants + EXIF strip + lat/lng en DB séparé |
| **Statut** | `Accepted` |
| **Date** | `2026-05-12` |
| **Auteur** | CTO Clean Connect + `architecte-api` + `photos-rgpd` + `mobile` |
| **PRD lié** | `docs/prd/PRD-003-photos-paiements.md` |
| **Phase BMAD** | `Design` |
| **Pré-revue sécurité** | `docs/security-reviews/2026-05-12-prd-003-design-prereview.md` |

---

## 1. Contexte

PRD-003 impose un système de preuve photo AVANT/APRÈS :
- ≥ 3 photos `BEFORE` synchronisées pour passer `PAID → IN_PROGRESS`.
- ≥ 5 photos `AFTER` synchronisées pour passer `IN_PROGRESS → CLIENT_VALIDATION_PENDING`.
- Photos sensibles (intérieur domicile client) = **donnée personnelle RGPD**.
- Mode offline obligatoire (mobile 4G instable, parking souterrain).

**Contraintes** :
- Aucun binaire ne doit transiter par l'API NestJS (mémoire / bande passante / charge serveur).
- Idempotence d'upload côté serveur (mobile retry réseau ≠ doublons côté Cloudinary).
- Audit / litige : besoin de l'original intègre (preuve photographique non altérée).
- Display rapide pour l'UI client / prestataire : version optimisée (compressed, CDN, sans EXIF).
- Anti-fuite GPS via EXIF (un attaquant qui récupère une photo display ne doit pas pouvoir extraire la position du domicile client).

---

## 2. Décision

### 2.1 Storage : Cloudinary signed upload (pas S3 brut)

**Cloudinary retenu** pour : transformation native (compression, CDN), signed URLs courte expiration, EXIF strip natif (`exif=strip`), webhook signé (`x-cld-signature`), folders privés par mission, infra mature pour mobile direct upload.

**Refus S3** : nécessite de réimplémenter la moitié de Cloudinary (compression mobile-side, CDN custom, EXIF stripping manuel). DX largement inférieure pour MVP.

### 2.2 Flux upload — Mobile → Cloudinary direct (jamais via API)

```
1. Mobile génère UUID v4 client (uuidCapture) AVANT la capture.
2. Mobile capture photo (expo-camera) + compresse à 1600 px max, qualité JPEG 75 (~150-300 KB).
3. Mobile POST /v1/missions/{id}/photos/presign :
   { captureClientUuid, variant: 'DISPLAY' | 'ORIGINAL', mimeType, bytes, phase }
   → backend renvoie signature Cloudinary + publicId + PhotoUploadSession (TTL 5 min).
4. Mobile upload multipart direct à Cloudinary avec les params signés.
5. Cloudinary stocke avec type=private, EXIF strippé, retourne `public_id`.
6. Mobile POST /v1/missions/{id}/photos/confirm :
   { captureClientUuid, sessionId, cloudinaryPublicId, checksumSha256, gpsLatitude?, gpsLongitude? }
   → backend vérifie session, captureClientUuid, et crée la ligne Photo.
7. Cloudinary webhook (notification_type=upload, signé) → backend update Photo.syncedAt, bytes, width, height.
```

**Interdiction stricte (D16)** : **base64 uploads bannis**. Multipart direct uniquement.

### 2.3 Dual variant : ORIGINAL + DISPLAY (D17)

| Variant | public_id | Type Cloudinary | Transformations | Accès |
|---|---|---|---|---|
| `ORIGINAL` | `<env>/missions/{missionId}/{phase}/{captureClientUuid}/original` | `private` | **Aucune** (intégrité préservée). EXIF non strippé côté Cloudinary mais le binaire n'a pas d'EXIF GPS car le mobile a strippé avant upload (cf. §2.4). | ADMIN only (audit / litige). Signed URL 5 min. |
| `DISPLAY` | `<env>/missions/{missionId}/{phase}/{captureClientUuid}/display` | `private` | `f_auto, q_auto, w_1600`, `exif=strip` (anti-fuite GPS). | CLIENT, PRESTATAIRE assigné, ADMIN. Signed URL 5 min. |

- **Même `captureClientUuid`** pour les deux variants → contrainte DB `@@unique([missionId, captureClientUuid, variant])`.
- **Un seul `Photo.id`** côté DB par capture logique ? **Non** : 1 ligne `Photo` par variant pour audit independent (statuts, deletedAt, checksums distincts). Le pairing logique se fait via `captureClientUuid`.

### 2.4 EXIF + GPS — stripping côté mobile + lat/lng séparé en DB (D11 + Q3)

**Règle dure** :
1. **Côté mobile** : avant l'upload Cloudinary, l'EXIF (y compris GPS device) est strippé via `expo-image-manipulator` (compression + strip). Ceci protège contre une éventuelle fuite Cloudinary side-channel.
2. **Côté Cloudinary** : le upload preset force `exif=strip` (double sécurité). Le DISPLAY n'a aucun EXIF.
3. **Côté DB** : `Photo.gpsLatitude` / `Photo.gpsLongitude` / `Photo.gpsAccuracyMeters` sont stockés **séparément**, envoyés explicitement par le mobile dans le `confirm`. Aucun lien automatique avec l'EXIF.
4. **`gpsMissing = true`** si absent (cas Android permissions refusées, parking souterrain). Soft-fail accepté MVP (Q3).
5. **`flagSuspicious = true`** si distance photo GPS vs mission GPS > seuil (proposition senior-dev : 500 m). Pas de hard-block MVP (Q13).

**Justification anti-fuite** : Cloudinary peut être configuré pour exposer publiquement des photos ; en cas d'erreur de config humaine, le strip côté mobile garantit que **aucun GPS device** ne fuite, même sur des photos qui pourraient devenir accidentellement publiques. Le GPS reste **strictement contrôlé côté DB** (RBAC : ADMIN + prestataire assigné + client owner uniquement).

### 2.5 Idempotence — `captureClientUuid` + `PhotoUploadSession` (revue CTO)

1. **`captureClientUuid`** : UUID v4 généré **côté mobile** avant la capture. Persisté tel quel côté DB (`Photo.captureClientUuid` NOT NULL). Garantit l'idempotence retry réseau mobile.
2. **`PhotoUploadSession`** : jeton court à usage unique (TTL 5 min). Émis au `presign`, consommé au `confirm`. Lié à `(missionId, captureClientUuid, phase, variant)`.
3. **Au `confirm`** : le serveur vérifie que `body.captureClientUuid === session.captureClientUuid` ET que la session `missionId` correspond à l'URL `{id}` (anti cross-mission). Sinon `409 PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH` ou `409 PHOTO_UPLOAD_SESSION_MISSION_MISMATCH`.
4. **Session expirée** : `410 UPLOAD_SESSION_EXPIRED` (distinct de 409, sémantique HTTP correcte).
5. **Session déjà consommée** : `409 PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED`.

### 2.6 Limites de taille + MIME whitelist

- `bytes` ≤ **10 MiB** côté serveur (validation Zod + Cloudinary upload preset).
- `mimeType ∈ { image/jpeg, image/png, image/heic, image/webp }`. Refus stricts autres types (no PDF, no video).
- `checksumSha256` : envoyé par le mobile, vérifié serveur si nécessaire (anti-corruption transit).

### 2.7 Signed URL lecture — 5 min max

`GET /v1/photos/{id}/signed-url` retourne une URL Cloudinary signée `expires_at = now + 300s`. Pas d'URL publique permanente, pas de cache côté client (mobile rafraîchit à la demande).

---

## 3. Alternatives considérées

| Option | Pourquoi non retenue |
|---|---|
| **S3 brut** | Pas de transformation native (compression, CDN, EXIF strip). Réimplémentation Cloudinary. DX MVP médiocre. |
| **Une seule variante (DISPLAY uniquement)** | Perte de l'original intègre pour audit / litige. Impossible de prouver judiciairement qu'une photo n'a pas été altérée (Cloudinary applique des transformations). |
| **Une seule variante (ORIGINAL uniquement) + transformation runtime** | Bande passante mobile gaspillée (chaque consultation = recalcul Cloudinary + cache miss possible). DISPLAY pré-strippé EXIF = sûr par défaut. |
| **EXIF GPS conservé pour audit** | Risque RGPD majeur : si le binaire fuite (config Cloudinary, intercept réseau, …), l'attaquant a la position du domicile client. Refusé. Le GPS est en DB sous RBAC strict. |
| **Base64 upload via API** (D16 refusé) | Mémoire mobile saturée pour photos haute résolution, bande passante doublée (base64 = +33 %), charge backend inutile. Refusé. |
| **Upload binaire via backend NestJS proxy** | Le binaire transite par le serveur (CPU, mémoire, BW). Pas de scalabilité. Refus net. |
| **Cloudflare R2 + signed URLs** | Pas de transformation native ni d'EXIF strip. Même problème que S3. Hors scope MVP. |

---

## 4. Conséquences

### Positives

- **Performance mobile** : upload direct → Cloudinary, pas de proxy NestJS. CDN global.
- **RGPD by design** : EXIF strippé côté mobile + côté Cloudinary (double sécurité). GPS sous RBAC DB.
- **Idempotence robuste** : `captureClientUuid` + `PhotoUploadSession` empêchent doublons retry réseau + cross-mission.
- **Audit / litige** : ORIGINAL conservé intègre (admin only). Pas d'altération possible.
- **DX** : Cloudinary signed upload bien documenté, SDK officiel mature.

### Négatives / coûts assumés

- **Coût Cloudinary** : 2 stockages par photo (ORIGINAL + DISPLAY). Atténué par compression DISPLAY (~200 KB) et purge 30 j (ADR-010).
- **Complexité presign/confirm** : 2 round-trips backend pour 1 upload (vs 1 round-trip avec upload direct sans session). Acceptable car cela ajoute idempotence + RBAC vérifié + audit `PhotoUploadSession`.
- **Limite mobile** : nécessite stripping EXIF côté `expo-image-manipulator` (étape supplémentaire CPU mobile). Acceptable < 200 ms par photo sur device récent.

### Neutres (à surveiller)

- **Bande passante 4G** : compression mobile (1600 px, qualité 75) cible 150-300 KB. À monitorer en Verify (perf gate < 8 s upload p95 sur 4G).
- **Taux de retry** : métrique Pino `photos.upload.retry_count` pour ajuster TTL session si besoin.

---

## 5. Suivi

- [x] Schéma Prisma `Photo` + `PhotoUploadSession` + enums (`PhotoType`, `PhotoVariant`, `PhotoDeletionReason`, `PhotoDeletionActor`).
- [x] OpenAPI `/v1/missions/{id}/photos/presign` + `.../confirm` + codes erreur `PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH`, `UPLOAD_SESSION_EXPIRED`.
- [x] Zod `@cc/shared-types/zod/photo.ts` aligné.
- [ ] **Build** : `PhotosService.presign()` + `.confirm()` + webhook Cloudinary handler signé + upload preset Cloudinary (`exif=strip`, `type=private`, `f_auto,q_auto,w_1600` pour DISPLAY).
- [ ] **Verify** : V4 (upload sans auth → 401), V5 (cross-mission → 403), V6 (AFTER sans BEFORE → 409), V9 (webhook Cloudinary spoofé → 400). Tests d'intégration container Cloudinary mock.
- [x] Mise à jour `.cursor/rules/photos-rgpd.mdc` (12 mois → 30 jours + dual variant + interdiction base64).
- [ ] Mobile : `expo-image-manipulator` strip + compress + `expo-file-system` queue MMKV (skill `offline-sync-pattern`).

---

## 6. Références

- PRD : [`docs/prd/PRD-003-photos-paiements.md`](../prd/PRD-003-photos-paiements.md) §2.3 + §6.1 V4-V6.
- Cahier des charges v1.4 : §5 (mode offline), §6.4 (sécurité photos), §6.5 (RGPD).
- Cloudinary docs : [Signed uploads](https://cloudinary.com/documentation/signed_url_authentication), [Private storage](https://cloudinary.com/documentation/control_access_to_media), [EXIF stripping](https://cloudinary.com/documentation/transformation_reference#exif).
- ADRs liées : [ADR-010 rétention photos 30 jours](ADR-010-photos-retention-30-days.md).

---

*ADR-009 v1.0 — PRD-003 Photos & Paiements — Sprint 3 Design.*
