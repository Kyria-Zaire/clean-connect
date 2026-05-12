/**
 * PRD-003 Ticket 3.3 — exceptions métier `Photos` (codes alignés
 * `photoErrorCodeSchema` côté `@cc/shared-types`).
 *
 * Conventions :
 *  - HTTP statuses mappés strictement à la sémantique :
 *      400 = input invalide (MIME refusé, bytes > 10 MiB).
 *      403 = RBAC / ownership refusé (cross-mission, non assigné).
 *      404 = mission / session inconnue (lookup failed).
 *      409 = state machine refusée (déjà consumed, mismatch captureClientUuid).
 *      410 = session expirée (`Gone` — sémantique HTTP correcte ADR-009).
 *      422 = règle métier (insufficient counts, anti-spoof Cloudinary).
 *      503 = `FF_PHOTOS_ENABLED=false`.
 *  - Aucun message Cloudinary brut côté `reason` (rule securite + Pino redactor).
 */

import type { PhotoErrorCode } from '@cc/shared-types'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

/** Body uniforme erreur Photos (aligné `PhotoErrorBody` OpenAPI). */
export interface PhotoErrorPayload {
  error: PhotoErrorCode
  reason?: string
}

function payload(code: PhotoErrorCode, reason?: string): PhotoErrorPayload {
  return reason ? { error: code, reason } : { error: code }
}

/** 503 — module Photos désactivé via feature flag. */
export class PhotosDisabledException extends ServiceUnavailableException {
  constructor() {
    super({
      error: 'PHOTOS_DISABLED' as PhotoErrorCode,
      reason: 'Le module Photos est désactivé sur cet environnement (FF_PHOTOS_ENABLED=false).',
    })
  }
}

/** 404 — la mission ciblée n'existe pas (ou soft-deleted). */
export class MissionNotFoundForPhotoException extends NotFoundException {
  constructor() {
    super(payload('PHOTO_NOT_FOUND', 'Mission introuvable pour cet upload.'))
  }
}

/** 403 — l'uploader n'est pas le prestataire assigné de la mission. */
export class PhotoForbiddenException extends ForbiddenException {
  constructor(reason?: string) {
    super(payload('PHOTO_FORBIDDEN', reason))
  }
}

/** 409 — la mission n'est pas dans un état qui autorise l'upload (Ticket 3.4). */
export class PhotoInvalidStateException extends ConflictException {
  constructor(reason: string) {
    super(payload('PHOTO_INVALID_STATE', reason))
  }
}

/** 410 — session expirée (sémantique HTTP correcte, rule photos-rgpd). */
export class PhotoUploadSessionExpiredException extends HttpException {
  constructor() {
    super(
      payload('PHOTO_UPLOAD_SESSION_EXPIRED', 'La session d\'upload est expirée (TTL 5 min).'),
      HttpStatus.GONE,
    )
  }
}

/** 409 — session déjà consommée (replay) — réponse idempotente côté service. */
export class PhotoUploadSessionAlreadyConsumedException extends ConflictException {
  constructor() {
    super(
      payload(
        'PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED',
        'Cette session a déjà été consommée. Demandez un nouveau presign.',
      ),
    )
  }
}

/** 409 — la mission de l'URL ne matche pas celle scellée dans la session. */
export class PhotoUploadSessionMissionMismatchException extends ConflictException {
  constructor() {
    super(
      payload(
        'PHOTO_UPLOAD_SESSION_MISSION_MISMATCH',
        "La session d'upload n'appartient pas à la mission ciblée par l'URL.",
      ),
    )
  }
}

/** 409 — `captureClientUuid` du body ≠ celui de la session. */
export class PhotoCaptureUuidMismatchException extends ConflictException {
  constructor() {
    super(
      payload(
        'PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH',
        'captureClientUuid ne correspond pas à celui scellé dans la session.',
      ),
    )
  }
}

/** 400 — MIME non whitelisté (Zod l'attrape normalement avant, mais on garde). */
export class PhotoMimeNotAllowedException extends BadRequestException {
  constructor(reason?: string) {
    super(payload('PHOTO_MIME_NOT_ALLOWED', reason))
  }
}

/** 400 — taille > 10 MiB (Zod l'attrape, garde-fou côté service). */
export class PhotoMaxBytesExceededException extends BadRequestException {
  constructor() {
    super(payload('PHOTO_MAX_BYTES_EXCEEDED', 'Taille fichier > 10 MiB (ADR-009).'))
  }
}

/** 422 — l'asset Cloudinary annoncé par le mobile n'existe pas côté Cloudinary. */
export class PhotoCloudinaryAssetMissingException extends UnprocessableEntityException {
  constructor() {
    super(
      payload(
        'PHOTO_INVALID_STATE',
        "Aucun asset Cloudinary trouvé pour le public_id sealed dans la session.",
      ),
    )
  }
}

/** 422 — `cloudinaryPublicId` du body ≠ celui scellé dans la session (anti-spoof). */
export class PhotoCloudinaryPublicIdMismatchException extends ConflictException {
  constructor() {
    super(
      payload(
        'PHOTO_INVALID_STATE',
        "cloudinaryPublicId fourni ≠ celui scellé dans la session (anti-spoof).",
      ),
    )
  }
}

/** 422 — bytes/mimeType reportés ne matchent pas ceux que Cloudinary a réellement reçu. */
export class PhotoMetadataMismatchException extends UnprocessableEntityException {
  constructor(reason: string) {
    super(payload('PHOTO_INVALID_STATE', reason))
  }
}
