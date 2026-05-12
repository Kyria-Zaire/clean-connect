/**
 * PRD-003 Ticket 3.3 — Repository Prisma pour `PhotoUploadSession` + `Photo`.
 *
 * Règles dures :
 *  - **Aucune logique métier** ici. Le service est seul à décider la transition.
 *  - Toutes les méthodes transactionnelles acceptent un `Prisma.TransactionClient`
 *    pour orchestration atomique côté service.
 *  - Les SELECT renvoient le row brut Prisma (le service mappe en DTO).
 */

import { Injectable } from '@nestjs/common'
import type {
  Photo,
  PhotoType,
  PhotoUploadSession,
  PhotoVariant,
  Prisma,
} from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'

@Injectable()
export class PhotosRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // PhotoUploadSession
  // ---------------------------------------------------------------------------

  /** Crée une session upload (presign). Retourne la ligne fraîchement insérée. */
  async createSession(input: {
    missionId: string
    uploaderUserId: string
    phase: PhotoType
    variant: PhotoVariant
    captureClientUuid: string
    tokenDigest: string
    expiresAt: Date
    mimeType: string
    cloudinaryPublicId: string
    maxBytes: number
  }): Promise<PhotoUploadSession> {
    return this.prisma.photoUploadSession.create({
      data: {
        missionId: input.missionId,
        uploaderUserId: input.uploaderUserId,
        phase: input.phase,
        variant: input.variant,
        captureClientUuid: input.captureClientUuid,
        tokenDigest: input.tokenDigest,
        expiresAt: input.expiresAt,
        mimeType: input.mimeType,
        cloudinaryPublicId: input.cloudinaryPublicId,
        maxBytes: input.maxBytes,
      },
    })
  }

  /** Lookup d'une session par `tokenDigest` (sha256 du token clair). */
  findSessionByTokenDigest(tokenDigest: string): Promise<PhotoUploadSession | null> {
    return this.prisma.photoUploadSession.findUnique({ where: { tokenDigest } })
  }

  findSessionById(sessionId: string): Promise<PhotoUploadSession | null> {
    return this.prisma.photoUploadSession.findUnique({ where: { id: sessionId } })
  }

  /**
   * Marque la session consommée (`consumedAt = now`) **uniquement** si elle ne
   * l'était pas encore. Retourne 1 si consommée à l'instant, 0 si déjà consumed
   * (race/replay). Le service gère la sémantique idempotente.
   */
  async markSessionConsumedTx(
    tx: Prisma.TransactionClient,
    sessionId: string,
    consumedAt: Date,
  ): Promise<number> {
    const r = await tx.photoUploadSession.updateMany({
      where: { id: sessionId, consumedAt: null },
      data: { consumedAt },
    })
    return r.count
  }

  /**
   * PRD-004 Ticket 4.2 — Orphan cleanup (risque faible).
   *
   * Supprime les `PhotoUploadSession` :
   *  - `expiresAt < cutoff` (TTL dépassé d'au moins `bufferMs`)
   *  - `consumedAt IS NULL` (jamais consommée — `confirm` n'a pas réussi)
   *  - PAS de `Photo` rattachée (`photos: { none: {} }`) — défense en profondeur
   *    si un confirm s'est terminé mais n'a pas updaté `consumedAt` (cas rare,
   *    bug applicatif corrigé en PR séparée mais protection ici).
   *
   * Risque : nul côté Cloudinary — on **ne supprime pas l'asset Cloudinary**
   * (ce serait risqué : potentiel asset uploadé puis confirm en cours de
   * réseau). Le cleanup Cloudinary est dette explicite Ticket 4.4 / RGPD
   * (`docs/prd/PRD-004 §4.4.5 — cloudinary deletion guarantees`).
   *
   * Limite stricte `take` pour borner la charge d'un tick cron.
   * Retourne le nb de lignes supprimées (utile pour logs/metrics).
   */
  async deleteExpiredUnconsumedSessions(opts: {
    olderThan: Date
    limit: number
  }): Promise<number> {
    // Prisma ne supporte pas `LIMIT` natif dans `deleteMany` sur PostgreSQL.
    // On fait donc :
    //  1. select des IDs candidats (avec LIMIT borné)
    //  2. deleteMany WHERE id IN (...)
    // Évite l'explosion si la table accumule des semaines de sessions.
    const candidates = await this.prisma.photoUploadSession.findMany({
      where: {
        expiresAt: { lt: opts.olderThan },
        consumedAt: null,
        photos: { none: {} },
      },
      take: opts.limit,
      select: { id: true },
    })
    if (candidates.length === 0) return 0
    const r = await this.prisma.photoUploadSession.deleteMany({
      where: { id: { in: candidates.map((c) => c.id) } },
    })
    return r.count
  }

  // ---------------------------------------------------------------------------
  // Photo
  // ---------------------------------------------------------------------------

  /**
   * Lookup d'une photo existante (replay confirm idempotent).
   * Unique sur `(missionId, captureClientUuid, variant)` — cf. schema.prisma.
   */
  findPhotoByCapture(
    missionId: string,
    captureClientUuid: string,
    variant: PhotoVariant,
  ): Promise<Photo | null> {
    return this.prisma.photo.findUnique({
      where: {
        missionId_captureClientUuid_variant: { missionId, captureClientUuid, variant },
      },
    })
  }

  /**
   * Crée la ligne Photo (confirm). Le `id` est un UUID v4 généré client.
   * Le `url` legacy est figé à l'URL Cloudinary publique du `public_id` —
   * la lecture publique passe par signed URL (Ticket 3.4) ; `url` reste comme
   * pointeur d'audit.
   */
  async createPhotoTx(
    tx: Prisma.TransactionClient,
    input: {
      id: string
      missionId: string
      uploadedByUserId: string
      type: PhotoType
      variant: PhotoVariant
      captureClientUuid: string
      photoUploadSessionId: string
      cloudinaryPublicId: string
      checksumSha256: string | null
      gpsLatitude: number | null
      gpsLongitude: number | null
      gpsAccuracyMeters: number | null
      gpsMissing: boolean
      imageWidth: number
      imageHeight: number
      bytes: number
      syncedAt: Date
      url: string
    },
  ): Promise<Photo> {
    return tx.photo.create({
      data: {
        id: input.id,
        missionId: input.missionId,
        uploadedByUserId: input.uploadedByUserId,
        type: input.type,
        variant: input.variant,
        captureClientUuid: input.captureClientUuid,
        photoUploadSessionId: input.photoUploadSessionId,
        cloudinaryPublicId: input.cloudinaryPublicId,
        checksumSha256: input.checksumSha256,
        gpsLatitude: input.gpsLatitude,
        gpsLongitude: input.gpsLongitude,
        gpsAccuracyMeters: input.gpsAccuracyMeters,
        gpsMissing: input.gpsMissing,
        imageWidth: input.imageWidth,
        imageHeight: input.imageHeight,
        bytes: input.bytes,
        syncedAt: input.syncedAt,
        url: input.url,
      },
    })
  }
}
