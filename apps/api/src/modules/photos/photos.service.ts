/**
 * PRD-003 Ticket 3.3 — `PhotosService` (orchestration presign + confirm).
 *
 * Responsabilités :
 *  - Vérifier le feature flag (`FF_PHOTOS_ENABLED`) → 503 si désactivé.
 *  - Vérifier l'existence de la mission (404) + RBAC ownership (403).
 *  - Générer la session opaque (token clair + `tokenDigest` SHA-256 stocké).
 *  - Signer les paramètres Cloudinary signed upload (folder + public_id figés serveur).
 *  - Au `confirm` :
 *      • Authentifier la session via tokenDigest (anti session-id leak).
 *      • Garde-fous : missionId match, captureClientUuid match, expiration < 410.
 *      • Idempotence : si Photo (missionId, captureClientUuid, variant) existe déjà
 *        → réponse `idempotent: true` (200 OK).
 *      • Vérifier côté Cloudinary que l'asset existe (anti-spoof mobile).
 *      • Insertion atomique : marque session consumed + create Photo + audit event.
 *
 * Sécurité :
 *  - Le binaire ne transite **JAMAIS** par l'API (rule photos-rgpd + ADR-009).
 *  - Le `cloudinaryPublicId` est figé serveur dès la session (folder + variant).
 *  - GPS séparé d'EXIF : reçu via body uniquement (mobile l'envoie explicitement).
 */

import { randomBytes } from 'node:crypto'

import type {
  ConfirmPhotoUploadInput,
  ConfirmPhotoUploadResponse,
  PhotoUploadSignatureResponse,
  PresignPhotoUploadInput,
} from '@cc/shared-types'
import { PHOTO_ALLOWED_MIME_TYPES, PHOTO_MAX_BYTES } from '@cc/shared-types'
import { Injectable, Logger } from '@nestjs/common'
import type { Mission, PhotoUploadSession, Role } from '@prisma/client'

import { loadEnv } from '../../common/config/env'
import { PrismaService } from '../../common/prisma/prisma.service'
import { MissionEventService } from '../missions/services/mission-event.service'

import {
  CloudinaryClient,
  CloudinaryResourceNotFoundError,
} from './cloudinary/cloudinary.client'
import {
  MissionNotFoundForPhotoException,
  PhotoCaptureUuidMismatchException,
  PhotoCloudinaryAssetMissingException,
  PhotoCloudinaryPublicIdMismatchException,
  PhotoForbiddenException,
  PhotoMaxBytesExceededException,
  PhotoMetadataMismatchException,
  PhotoMimeNotAllowedException,
  PhotosDisabledException,
  PhotoUploadSessionAlreadyConsumedException,
  PhotoUploadSessionExpiredException,
  PhotoUploadSessionMissionMismatchException,
} from './photos.errors'
import { PhotosRepository } from './photos.repository'

/** Acteur déclencheur — porté par le guard JWT (`@CurrentUser`). */
export interface PhotoActor {
  readonly id: string
  readonly role: Role
}

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name)
  private readonly featureEnabled: boolean
  private readonly folderPrefix: string
  private readonly sessionTtlSeconds: number

  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosRepository,
    private readonly missionEvents: MissionEventService,
    private readonly cloudinary: CloudinaryClient,
  ) {
    const env = loadEnv()
    this.featureEnabled = env.FF_PHOTOS_ENABLED
    this.folderPrefix = env.CLOUDINARY_FOLDER_PREFIX
    this.sessionTtlSeconds = env.PHOTO_UPLOAD_SESSION_TTL_SECONDS
  }

  // ---------------------------------------------------------------------------
  // PRESIGN — POST /v1/missions/:id/photos/presign
  // ---------------------------------------------------------------------------

  async presign(
    missionId: string,
    actor: PhotoActor,
    input: PresignPhotoUploadInput,
  ): Promise<PhotoUploadSignatureResponse> {
    this.assertEnabled()
    this.assertInputBounds(input.mimeType, input.bytes)

    const mission = await this.loadMissionForUpload(missionId)
    this.assertCanUploadForMission(mission, actor)

    if (input.missionId !== missionId) {
      // Pré-Zod laisserait passer ; l'invariant URL=body est défensif.
      throw new PhotoUploadSessionMissionMismatchException()
    }

    const folder = this.buildFolder(missionId, input.phase, input.captureClientUuid)
    const publicId = `${folder}/${input.variant.toLowerCase()}`
    const opaqueToken = randomBytes(32).toString('hex')
    const tokenDigest = CloudinaryClient.digestToken(opaqueToken)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000)

    const session = await this.photos.createSession({
      missionId,
      uploaderUserId: actor.id,
      phase: input.phase,
      variant: input.variant,
      captureClientUuid: input.captureClientUuid,
      tokenDigest,
      expiresAt,
      mimeType: input.mimeType,
      cloudinaryPublicId: publicId,
      maxBytes: PHOTO_MAX_BYTES,
    })

    const signed = this.cloudinary.signUploadParams({
      folder,
      publicId,
      mimeType: input.mimeType,
      maxBytes: PHOTO_MAX_BYTES,
    })

    await this.missionEvents.record({
      missionId,
      type: 'PHOTO_UPLOAD_PRESIGNED',
      actorUserId: actor.id,
      payload: {
        sessionId: session.id,
        phase: input.phase,
        variant: input.variant,
        captureClientUuid: input.captureClientUuid,
        expiresAt: expiresAt.toISOString(),
      },
    })

    this.logger.log(
      {
        missionId,
        sessionId: session.id,
        phase: input.phase,
        variant: input.variant,
        ttlSec: this.sessionTtlSeconds,
      },
      'photos.presign.created',
    )

    return {
      photoUploadSessionId: session.id,
      sessionToken: opaqueToken,
      uploadUrl: signed.uploadUrl,
      cloudinaryParams: {
        public_id: signed.publicId,
        folder: signed.folder,
        type: signed.type,
        timestamp: String(signed.timestamp),
        signature: signed.signature,
        api_key: signed.apiKey,
        cloud_name: signed.cloudName,
      },
      expiresAt: expiresAt.toISOString(),
      maxBytes: signed.maxBytes,
      allowedMimeTypes: [...PHOTO_ALLOWED_MIME_TYPES],
    }
  }

  // ---------------------------------------------------------------------------
  // CONFIRM — POST /v1/missions/:id/photos/confirm
  // ---------------------------------------------------------------------------

  async confirm(
    missionId: string,
    actor: PhotoActor,
    input: ConfirmPhotoUploadInput,
  ): Promise<ConfirmPhotoUploadResponse> {
    this.assertEnabled()

    const mission = await this.loadMissionForUpload(missionId)
    this.assertCanUploadForMission(mission, actor)

    const session = await this.authenticateSession(input)
    if (session.missionId !== missionId) {
      throw new PhotoUploadSessionMissionMismatchException()
    }
    if (session.uploaderUserId !== actor.id) {
      // Anti session-stealing : un autre prestataire ne peut pas re-jouer
      // une session avec son JWT.
      throw new PhotoForbiddenException('Session non émise pour cet utilisateur.')
    }
    if (session.captureClientUuid !== input.captureClientUuid) {
      throw new PhotoCaptureUuidMismatchException()
    }
    if (session.cloudinaryPublicId !== input.cloudinaryPublicId) {
      throw new PhotoCloudinaryPublicIdMismatchException()
    }

    // Idempotence : si la Photo existe déjà, renvoyer le DTO existant sans muter.
    const existing = await this.photos.findPhotoByCapture(
      missionId,
      input.captureClientUuid,
      session.variant,
    )
    if (existing) {
      this.logger.log(
        { photoId: existing.id, missionId },
        'photos.confirm.idempotent_replay',
      )
      return this.buildConfirmResponse(existing, missionId, session, true)
    }

    // Session non encore consommée → vérifier expiration.
    if (session.consumedAt !== null) {
      // Cas : session consumed mais Photo absente (race insertion). On refuse pour
      // garder l'invariant 1 session = 1 photo.
      throw new PhotoUploadSessionAlreadyConsumedException()
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new PhotoUploadSessionExpiredException()
    }

    // Vérifier l'existence côté Cloudinary (anti-spoof mobile).
    let resource
    try {
      resource = await this.cloudinary.getResource(session.cloudinaryPublicId)
    } catch (err) {
      if (err instanceof CloudinaryResourceNotFoundError) {
        throw new PhotoCloudinaryAssetMissingException()
      }
      throw err
    }

    // Re-vérifier cohérence bytes/mimeType (le mobile peut mentir).
    if (resource.bytes > PHOTO_MAX_BYTES) {
      throw new PhotoMaxBytesExceededException()
    }
    const reportedFormat = input.mimeType.split('/')[1]
    if (!reportedFormat || resource.format.toLowerCase() !== reportedFormat.toLowerCase()) {
      // jpeg / png / webp / heic — on tolère que jpeg <-> jpg côté Cloudinary.
      const jpegAlias = reportedFormat === 'jpeg' && resource.format.toLowerCase() === 'jpg'
      if (!jpegAlias) {
        throw new PhotoMetadataMismatchException(
          `Cloudinary format=${resource.format} ne matche pas mimeType=${input.mimeType}.`,
        )
      }
    }

    const photoUrl = this.buildLegacyUrl(resource.publicId, resource.version)
    const now = new Date()

    const created = await this.prisma.$transaction(async (tx) => {
      const consumedCount = await this.photos.markSessionConsumedTx(tx, session.id, now)
      if (consumedCount !== 1) {
        // Race rare — un autre worker a consumed ; on retombe idempotent.
        const racedPhoto = await tx.photo.findUnique({
          where: {
            missionId_captureClientUuid_variant: {
              missionId,
              captureClientUuid: input.captureClientUuid,
              variant: session.variant,
            },
          },
        })
        if (racedPhoto) return { photo: racedPhoto, idempotent: true as const }
        throw new PhotoUploadSessionAlreadyConsumedException()
      }

      const photo = await this.photos.createPhotoTx(tx, {
        id: input.photoId,
        missionId,
        uploadedByUserId: actor.id,
        type: session.phase,
        variant: session.variant,
        captureClientUuid: input.captureClientUuid,
        photoUploadSessionId: session.id,
        cloudinaryPublicId: session.cloudinaryPublicId,
        checksumSha256: input.checksumSha256,
        gpsLatitude: input.gps.gpsLatitude,
        gpsLongitude: input.gps.gpsLongitude,
        gpsAccuracyMeters: input.gps.gpsAccuracyMeters ?? null,
        gpsMissing: input.gps.gpsLatitude === null || input.gps.gpsLongitude === null,
        imageWidth: resource.width,
        imageHeight: resource.height,
        bytes: resource.bytes,
        syncedAt: now,
        url: photoUrl,
      })

      await this.missionEvents.recordTx(tx, {
        missionId,
        type: 'PHOTO_CONFIRMED',
        actorUserId: actor.id,
        payload: {
          photoId: photo.id,
          sessionId: session.id,
          phase: session.phase,
          variant: session.variant,
          gpsMissing: photo.gpsMissing,
          bytes: resource.bytes,
        },
      })

      return { photo, idempotent: false as const }
    })

    this.logger.log(
      {
        photoId: created.photo.id,
        missionId,
        variant: session.variant,
        phase: session.phase,
        idempotent: created.idempotent,
      },
      'photos.confirm.processed',
    )

    return this.buildConfirmResponse(created.photo, missionId, session, created.idempotent)
  }

  // ---------------------------------------------------------------------------
  // Helpers internes
  // ---------------------------------------------------------------------------

  private assertEnabled(): void {
    if (!this.featureEnabled) throw new PhotosDisabledException()
  }

  private assertInputBounds(mimeType: string, bytes: number): void {
    if (!PHOTO_ALLOWED_MIME_TYPES.includes(mimeType as never)) {
      throw new PhotoMimeNotAllowedException(`MIME ${mimeType} non whitelisté.`)
    }
    if (bytes > PHOTO_MAX_BYTES) {
      throw new PhotoMaxBytesExceededException()
    }
  }

  private async loadMissionForUpload(missionId: string): Promise<Mission> {
    const mission = await this.prisma.mission.findUnique({
      where: { id: missionId },
      select: {
        id: true,
        clientId: true,
        prestataireId: true,
        status: true,
      },
    })
    if (!mission) throw new MissionNotFoundForPhotoException()
    return mission as unknown as Mission
  }

  /**
   * RBAC — en Ticket 3.3 strict :
   *  - PRESTATAIRE assigné de la mission (mission.prestataireId === actor.id).
   *  - ADMIN bypass (debug / support).
   * Le CLIENT propriétaire n'upload pas en MVP (cf. cahier §6.4 : seules les
   * photos BEFORE/AFTER côté terrain, prises par le prestataire).
   */
  private assertCanUploadForMission(mission: Mission, actor: PhotoActor): void {
    if (actor.role === 'ADMIN') return
    if (actor.role !== 'PRESTATAIRE') {
      throw new PhotoForbiddenException(
        'Seul le prestataire assigné (ou ADMIN) peut uploader des photos.',
      )
    }
    if (mission.prestataireId !== actor.id) {
      throw new PhotoForbiddenException(
        'Vous n\'êtes pas le prestataire assigné de cette mission.',
      )
    }
  }

  /**
   * Vérifie la cohérence `sessionToken` ↔ `tokenDigest` ↔ `photoUploadSessionId`.
   * Deux lookups car la session pourrait avoir un ID forgé qui ne matche pas
   * le token — on ne fait confiance qu'au digest pour authentifier la session.
   */
  private async authenticateSession(
    input: ConfirmPhotoUploadInput,
  ): Promise<PhotoUploadSession> {
    const digest = CloudinaryClient.digestToken(input.sessionToken)
    const session = await this.photos.findSessionByTokenDigest(digest)
    if (!session || session.id !== input.photoUploadSessionId) {
      // L'ID de session forgé sans le bon token → on traite comme not found
      // (anti-énumération + cohérence sémantique : la session "n'existe pas
      // pour cet utilisateur").
      throw new PhotoUploadSessionAlreadyConsumedException()
    }
    return session
  }

  private buildFolder(missionId: string, phase: string, captureClientUuid: string): string {
    return `${this.folderPrefix}/missions/${missionId}/${phase.toLowerCase()}/${captureClientUuid}`
  }

  private buildLegacyUrl(publicId: string, version: number): string {
    // Le `url` Prisma est legacy/audit (lecture passe par signed URL Ticket 3.4).
    // On stocke une URL Cloudinary version pinnée non publique (rule securite —
    // pas de lecture directe sans signature).
    return `cloudinary://private/v${version}/${publicId}`
  }

  private buildConfirmResponse(
    photo: {
      id: string
      bytes: number | null
      imageWidth: number | null
      imageHeight: number | null
      gpsMissing: boolean
      syncedAt: Date | null
      captureClientUuid: string
    },
    missionId: string,
    session: Pick<PhotoUploadSession, 'phase' | 'variant'>,
    idempotent: boolean,
  ): ConfirmPhotoUploadResponse {
    return {
      photoId: photo.id,
      missionId,
      phase: session.phase,
      variant: session.variant,
      captureClientUuid: photo.captureClientUuid,
      bytes: photo.bytes ?? 0,
      imageWidth: photo.imageWidth ?? 0,
      imageHeight: photo.imageHeight ?? 0,
      gpsMissing: photo.gpsMissing,
      syncedAt: (photo.syncedAt ?? new Date()).toISOString(),
      idempotent,
    }
  }
}
