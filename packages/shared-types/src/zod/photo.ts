/**
 * Contrats Zod — Photo + PhotoUploadSession + PhotoDeletionLog (PRD-003 livrable 2/5).
 *
 * Source de vérité : `apps/api/prisma/schema.prisma` (Photo, PhotoUploadSession,
 * PhotoDeletionLog, PhotoType, PhotoVariant, PhotoDeletionReason, PhotoDeletionActor).
 *
 * ============================================================================
 * RÈGLES STRICTES — directive CTO PRD-003 livrable 2/5
 * ============================================================================
 *
 * 1. **Upload schemas** :
 *    - MIME whitelist : `image/jpeg`, `image/png`, `image/heic`, `image/webp`.
 *    - `maxBytes` : 10 Mo dur côté API (ADR-009).
 *    - Phase (`PhotoType`) : `BEFORE` / `AFTER`.
 *    - Variant (`PhotoVariant`) : `ORIGINAL` / `DISPLAY`.
 *    - `captureClientUuid` obligatoire (idempotence + appariement ORIGINAL/DISPLAY).
 *    - GPS borné (lat ±90 / lng ±180 / accuracy ≤ 10 km).
 *
 * 2. **Aucun schéma public n'expose** :
 *    - `tokenDigest` (PhotoUploadSession — secret SHA-256, INTERNAL ONLY).
 *    - `checksumSha256` côté client/prestataire (Internal admin uniquement).
 *    - `cloudinaryPublicId` brut côté client/prestataire (on expose des
 *      signed URLs courtes, pas l'asset ID Cloudinary).
 *    - Variant `ORIGINAL` au prestataire (sécurité EXIF / lat brute → DISPLAY only).
 *
 * 3. **Cohérence GPS** : `gpsLatitude` et `gpsLongitude` co-présents OU les deux NULL.
 *    Si NULL → `gpsMissing=true` (audit interne, mission non bloquée — décision CTO Q3).
 */

import { z } from 'zod'

import {
  PhotoDeletionActorSchema,
  PhotoDeletionReasonSchema,
  PhotoTypeSchema,
  PhotoVariantSchema,
} from './enums'
import {
  gpsAccuracyMetersSchema,
  isoDateSchema,
  latitudeSchema,
  longitudeSchema,
  moneyCentsSchema,
  sha256HexSchema,
  uuidSchema,
} from './primitives'

// ============================================================================
// CONSTANTES — exposées pour tests + client mobile
// ============================================================================

/** Whitelist MIME upload photo (ADR-009 — pas de tiff/raw/bitmap MVP). */
export const PHOTO_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const
export type PhotoAllowedMimeType = (typeof PHOTO_ALLOWED_MIME_TYPES)[number]

/** Taille max upload — 10 Mo (ADR-009). Mobile doit compresser AVANT (1600 px / qualité 75 → ~150-300 Ko). */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024

/** Quotas mission (PRD-003 §1.5 + décision CTO Q3) — bloque la complétion sinon. */
export const PHOTO_MIN_BEFORE = 3
export const PHOTO_MIN_AFTER = 5
export const PHOTO_MAX_PER_PHASE = 20

// ============================================================================
// PRIMITIVE — MIME whitelist + bytes positifs bornés
// ============================================================================

export const photoMimeTypeSchema = z.enum(PHOTO_ALLOWED_MIME_TYPES)
export type PhotoMimeType = z.infer<typeof photoMimeTypeSchema>

export const photoBytesSchema = z
  .number()
  .int()
  .positive('Taille photo doit être > 0.')
  .max(PHOTO_MAX_BYTES, `Taille photo max ${PHOTO_MAX_BYTES} bytes (10 Mo).`)
export type PhotoBytes = z.infer<typeof photoBytesSchema>

// ============================================================================
// GPS — cohérence latitude/longitude co-présents ou tous deux NULL.
// ============================================================================

/**
 * Bloc GPS optionnel : soit tout NULL, soit `lat+lng` co-présents.
 * `accuracyMeters` reste optionnel même quand lat/lng sont renseignés.
 */
export const photoGpsInputSchema = z
  .object({
    gpsLatitude: latitudeSchema.nullable(),
    gpsLongitude: longitudeSchema.nullable(),
    gpsAccuracyMeters: gpsAccuracyMetersSchema.nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasLat = data.gpsLatitude !== null
    const hasLng = data.gpsLongitude !== null
    if (hasLat !== hasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gpsLatitude'],
        message: 'gpsLatitude et gpsLongitude doivent être tous deux NULL ou tous deux renseignés.',
      })
    }
    if (!hasLat && data.gpsAccuracyMeters !== null && data.gpsAccuracyMeters !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gpsAccuracyMeters'],
        message: 'gpsAccuracyMeters interdit si gpsLatitude/gpsLongitude sont NULL.',
      })
    }
  })
export type PhotoGpsInput = z.infer<typeof photoGpsInputSchema>

// ============================================================================
// 1) INPUT — pré-signature + confirmation upload
// ============================================================================

/**
 * `POST /photos/sign` — demande de signed upload Cloudinary.
 *
 * - Lien `captureClientUuid` ⇄ paire ORIGINAL+DISPLAY (idempotence upload).
 * - GPS bloc partagé via `photoGpsInputSchema`.
 * - `mimeType` validé contre whitelist serveur (ADR-009).
 * - `bytes` déclaré : serveur valide ≤ 10 Mo avant signature (anti-coup-de-faux Cloudinary).
 *
 * Output : `PhotoUploadSession` (token signé, expiresAt 5min, etc.).
 */
export const presignPhotoUploadInputSchema = z
  .object({
    missionId: uuidSchema,
    phase: PhotoTypeSchema,
    variant: PhotoVariantSchema,
    /** UUID v4 généré côté mobile (obligatoire — clé d'idempotence). */
    captureClientUuid: uuidSchema,
    bytes: photoBytesSchema,
    mimeType: photoMimeTypeSchema,
    gps: photoGpsInputSchema,
  })
  .strict()
export type PresignPhotoUploadInput = z.infer<typeof presignPhotoUploadInputSchema>

/**
 * `POST /photos/confirm` — callback mobile après upload Cloudinary réussi.
 *
 * - `photoUploadSessionId` consomme la session (mono-usage, `consumedAt`).
 * - `cloudinaryPublicId` retourné par Cloudinary (jamais exposé client après).
 * - `checksumSha256` calculé mobile sur ORIGINAL pour intégrité (interne).
 * - `imageWidth`/`imageHeight` métadonnées pour rendering (sans EXIF).
 */
export const confirmPhotoUploadInputSchema = z
  .object({
    photoUploadSessionId: uuidSchema,
    captureClientUuid: uuidSchema,
    cloudinaryPublicId: z.string().min(1).max(1024),
    checksumSha256: sha256HexSchema,
    imageWidth: z.number().int().positive().max(20_000),
    imageHeight: z.number().int().positive().max(20_000),
    bytes: photoBytesSchema,
    mimeType: photoMimeTypeSchema,
    gps: photoGpsInputSchema,
  })
  .strict()
export type ConfirmPhotoUploadInput = z.infer<typeof confirmPhotoUploadInputSchema>

/** `GET /missions/:id/photos` — query list (avec filtre phase optionnel). */
export const listMissionPhotosQuerySchema = z
  .object({
    phase: PhotoTypeSchema.optional(),
    /** Force la variant exposée : DISPLAY par défaut (jamais ORIGINAL au prestataire). */
    variant: PhotoVariantSchema.optional(),
  })
  .strict()
export type ListMissionPhotosQuery = z.infer<typeof listMissionPhotosQuerySchema>

// ============================================================================
// 2) INTERNAL — représentation DB (jamais sérialisée publique)
// ============================================================================

/**
 * PhotoUploadSession — INTERNAL uniquement.
 * **NE JAMAIS sérialiser `tokenDigest`** (SHA-256 du token — fuite = vol).
 * Le `token` clair n'est jamais stocké en DB ; le digest n'est qu'une trace
 * d'audit serveur-only.
 */
export const photoUploadSessionInternalSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    uploaderUserId: uuidSchema,
    phase: PhotoTypeSchema,
    /** Variant ciblée : ORIGINAL ou DISPLAY (cf. ADR-009 dual variant). */
    variant: PhotoVariantSchema,
    /** SHA-256 du token clair — usage interne seulement. */
    tokenDigest: sha256HexSchema,
    expiresAt: isoDateSchema,
    consumedAt: isoDateSchema.nullable(),
    maxBytes: photoBytesSchema,
    captureClientUuid: uuidSchema,
    createdAt: isoDateSchema,
  })
  .strict()
export type PhotoUploadSessionInternal = z.infer<typeof photoUploadSessionInternalSchema>

/**
 * Photo — INTERNAL (mapping Prisma complet).
 *
 * Source de vérité serveur : utilisé par les services pour valider les sorties
 * Prisma avant projection en `*View`.
 */
export const photoInternalSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    uploadedByUserId: uuidSchema,
    type: PhotoTypeSchema,
    variant: PhotoVariantSchema,
    captureClientUuid: uuidSchema,
    photoUploadSessionId: uuidSchema.nullable(),
    cloudinaryPublicId: z.string().min(1).max(1024),
    checksumSha256: sha256HexSchema,
    gpsLatitude: latitudeSchema.nullable(),
    gpsLongitude: longitudeSchema.nullable(),
    gpsAccuracyMeters: gpsAccuracyMetersSchema.nullable(),
    gpsMissing: z.boolean(),
    flagSuspicious: z.boolean(),
    syncedAt: isoDateSchema.nullable(),
    imageWidth: z.number().int().positive().max(20_000).nullable(),
    imageHeight: z.number().int().positive().max(20_000).nullable(),
    bytes: moneyCentsSchema.nullable(), // entier ≥ 0 ; on réutilise le schéma "int positif borné".
    deletedAt: isoDateSchema.nullable(),
    capturedAt: isoDateSchema,
    createdAt: isoDateSchema,
  })
  .strict()
export type PhotoInternal = z.infer<typeof photoInternalSchema>

/** PhotoDeletionLog — INTERNAL admin/audit. */
export const photoDeletionLogInternalSchema = z
  .object({
    id: uuidSchema,
    photoId: uuidSchema,
    missionId: uuidSchema,
    reason: PhotoDeletionReasonSchema,
    performedBy: PhotoDeletionActorSchema,
    batchId: uuidSchema.nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: isoDateSchema,
  })
  .strict()
export type PhotoDeletionLogInternal = z.infer<typeof photoDeletionLogInternalSchema>

// ============================================================================
// 3) PUBLIC — DTOs API (RBAC-aware)
// ============================================================================

/**
 * Réponse `POST /photos/sign` — exposée au **PRESTATAIRE** uniquement.
 *
 * - `uploadToken` est *retourné une seule fois* en clair (signé Cloudinary).
 *   **JAMAIS persisté** ni reloggué (filter Pino redactor : `uploadToken`,
 *   `cloudinaryParams.signature`).
 * - `uploadUrl` Cloudinary direct (multipart).
 * - `expiresAt` court (5 min — ADR-009).
 */
export const photoUploadSignatureResponseSchema = z
  .object({
    photoUploadSessionId: uuidSchema,
    /** URL Cloudinary direct (`https://api.cloudinary.com/v1_1/<cloud>/image/upload`). */
    uploadUrl: z.string().url(),
    /** Paramètres signés Cloudinary à intégrer dans le multipart (timestamp, signature, folder, public_id, etc.). */
    cloudinaryParams: z.record(z.string()),
    expiresAt: isoDateSchema,
    maxBytes: photoBytesSchema,
    allowedMimeTypes: z.array(photoMimeTypeSchema).nonempty(),
  })
  .strict()
export type PhotoUploadSignatureResponse = z.infer<typeof photoUploadSignatureResponseSchema>

/**
 * Vue publique d'une Photo — exposée CLIENT et PRESTATAIRE.
 *
 * - `signedUrl` court-vivante (5 min) générée à la lecture (jamais persistée).
 * - **PAS** : `cloudinaryPublicId`, `checksumSha256`, `tokenDigest` (CTO refus explicite).
 * - `variant` filtré côté service : prestataire/client ne voit que `DISPLAY`
 *   (ORIGINAL réservé admin sécurité).
 * - `flagSuspicious` masqué côté contrepartie (visible admin uniquement).
 */
export const publicPhotoSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    type: PhotoTypeSchema,
    /** Toujours `DISPLAY` côté client/prestataire (filtré service). */
    variant: PhotoVariantSchema,
    /** Signed URL Cloudinary courte (5 min) — régénérée à chaque GET. */
    signedUrl: z.string().url(),
    signedUrlExpiresAt: isoDateSchema,
    imageWidth: z.number().int().positive().max(20_000).nullable(),
    imageHeight: z.number().int().positive().max(20_000).nullable(),
    /** GPS exposé tel quel (utile transparence) — pas considéré secret. */
    gpsLatitude: latitudeSchema.nullable(),
    gpsLongitude: longitudeSchema.nullable(),
    gpsAccuracyMeters: gpsAccuracyMetersSchema.nullable(),
    gpsMissing: z.boolean(),
    capturedAt: isoDateSchema,
    syncedAt: isoDateSchema.nullable(),
  })
  .strict()
export type PublicPhoto = z.infer<typeof publicPhotoSchema>

/**
 * Vue ADMIN d'une Photo — visibilité complète (audit / antifraude).
 *
 * Ajoute : `checksumSha256`, `cloudinaryPublicId`, `flagSuspicious`,
 * et la variante `ORIGINAL` autorisée (l'asset original sécurisé).
 */
export const adminPhotoViewSchema = publicPhotoSchema
  .extend({
    cloudinaryPublicId: z.string().min(1).max(1024),
    /** Visible admin uniquement — checksum ORIGINAL/DISPLAY indistinct côté retour. */
    checksumSha256: sha256HexSchema,
    flagSuspicious: z.boolean(),
    deletedAt: isoDateSchema.nullable(),
  })
  .strict()
export type AdminPhotoView = z.infer<typeof adminPhotoViewSchema>

/** Réponse list `GET /missions/:id/photos`. */
export const publicPhotoListResponseSchema = z
  .object({
    items: z.array(publicPhotoSchema),
    counts: z
      .object({
        BEFORE: z.number().int().nonnegative(),
        AFTER: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type PublicPhotoListResponse = z.infer<typeof publicPhotoListResponseSchema>

// ============================================================================
// 4) Codes erreur métier
// ============================================================================

export const photoErrorCodeSchema = z.enum([
  'PHOTO_NOT_FOUND',
  'PHOTO_FORBIDDEN',
  'PHOTO_INVALID_STATE',
  'PHOTO_UPLOAD_SESSION_EXPIRED',
  'PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED',
  'PHOTO_UPLOAD_SESSION_MISSION_MISMATCH',
  'PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH',
  'PHOTO_CHECKSUM_MISMATCH',
  'PHOTO_MIME_NOT_ALLOWED',
  'PHOTO_MAX_BYTES_EXCEEDED',
  'PHOTO_MAX_COUNT_EXCEEDED',
  'PHOTO_INSUFFICIENT_BEFORE',
  'PHOTO_INSUFFICIENT_AFTER',
  'PHOTO_DELETION_FORBIDDEN',
  'PHOTO_GPS_INCONSISTENT',
  'UPLOAD_SESSION_EXPIRED',
])
export type PhotoErrorCode = z.infer<typeof photoErrorCodeSchema>

export const photoErrorResponseSchema = z
  .object({
    error: photoErrorCodeSchema,
    reason: z.string().max(500).optional(),
  })
  .strict()
export type PhotoErrorResponse = z.infer<typeof photoErrorResponseSchema>
