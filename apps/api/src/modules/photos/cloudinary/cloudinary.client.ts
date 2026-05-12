/**
 * PRD-003 Ticket 3.3 — Cloudinary client.
 *
 * Règles dures (rule securite + rule photos-rgpd + ADR-009) :
 *  - Le mobile upload **directement** à Cloudinary, jamais via l'API NestJS.
 *  - **Signed upload uniquement** (`type='private'`) — pas d'URL publique permanente.
 *  - **Aucune transformation EXIF côté serveur** : le mobile strip l'EXIF AVANT
 *    upload (expo-image-manipulator). On délègue cette responsabilité au client.
 *  - **Folder structure** :
 *      `${prefix}/missions/${missionId}/${phase}/${captureClientUuid}/${variant}`
 *    avec `phase ∈ {before, after}` et `variant ∈ {original, display}`.
 *  - **Public ID figé serveur** : le mobile ne peut pas le surcharger
 *    (signature scellée incluant `public_id`).
 *  - **JAMAIS de log de l'`api_secret`** (Pino redactor).
 *
 * Le binaire ne transite **jamais** par l'API. Le serveur :
 *  1. Construit `public_id`/`folder`/`timestamp` côté serveur.
 *  2. Signe HMAC-SHA-1 avec `api_secret`.
 *  3. Retourne au mobile les paramètres signés ; le mobile fait le multipart upload.
 *  4. Au `confirm`, vérifie via `api.resource(...)` que l'asset existe bien
 *     côté Cloudinary AVEC le `public_id` attendu (anti-spoof).
 */

import { createHash } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'
import { v2 as cloudinary } from 'cloudinary'

import { loadEnv } from '../../../common/config/env'

/** Token DI pour les services consommateurs (mock friendly). */
export const CLOUDINARY_CLIENT_TOKEN = 'CLOUDINARY_CLIENT' as const

/** Paramètres signés à transmettre tels quels au mobile pour multipart upload. */
export interface CloudinarySignedUploadParams {
  /** URL Cloudinary direct : `https://api.cloudinary.com/v1_1/<cloud>/image/upload`. */
  readonly uploadUrl: string
  readonly cloudName: string
  readonly apiKey: string
  /** Public ID complet (`folder/<variant>`). */
  readonly publicId: string
  /** Dossier privé Cloudinary (sans variant). */
  readonly folder: string
  /** Type d'asset Cloudinary — toujours `private` (rule photos-rgpd). */
  readonly type: 'private'
  /** Timestamp UNIX (secondes) — entré dans la signature HMAC. */
  readonly timestamp: number
  /** Signature HMAC-SHA-1 calculée côté serveur. */
  readonly signature: string
  /** Algorithme de signature explicite (Cloudinary défaut = sha1). */
  readonly signatureAlgorithm: 'sha1'
  /** MIME accepté côté serveur (le mobile DOIT envoyer un fichier de ce type). */
  readonly mimeType: string
  /** Taille max acceptée côté serveur (octets). */
  readonly maxBytes: number
}

/** Subset des champs Cloudinary `resource` consommés côté `confirm`. */
export interface CloudinaryResource {
  readonly publicId: string
  readonly format: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly version: number
  readonly resourceType: string
  readonly type: 'private' | 'upload' | 'authenticated'
}

/**
 * Erreur typée — l'asset Cloudinary attendu n'existe pas (mobile spoof / upload
 * échoué côté Cloudinary). Le service convertit en `409 PHOTO_INVALID_STATE`.
 */
export class CloudinaryResourceNotFoundError extends Error {
  constructor(readonly publicId: string) {
    super(`Cloudinary resource not found: ${publicId}`)
    this.name = 'CloudinaryResourceNotFoundError'
  }
}

/**
 * Erreur typée — l'API Cloudinary a retourné une erreur transverse (5xx, quota,
 * etc.). Le service convertit en `502 PHOTO_STORAGE_ERROR` (debt MVP : pas de
 * smart retry, on log + on remonte au mobile).
 */
export class CloudinaryApiError extends Error {
  constructor(readonly httpCode: number | null, message: string) {
    super(message)
    this.name = 'CloudinaryApiError'
  }
}

/** Configuration parsée pour usage interne (typage minimal). */
interface CloudinaryConfig {
  readonly cloudName: string
  readonly apiKey: string
  readonly apiSecret: string
}

/**
 * Parse une URL `cloudinary://<api_key>:<api_secret>@<cloud_name>` en credentials
 * structurés. La regex de format est déjà appliquée côté Zod (`env.ts`) — on
 * relit ici pour récupérer les groupes sans muter `process.env`.
 */
function parseCloudinaryUrl(url: string): CloudinaryConfig {
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@([a-zA-Z0-9_-]+)$/u)
  if (!m) {
    throw new Error('CLOUDINARY_URL invalide — format attendu cloudinary://<api_key>:<api_secret>@<cloud_name>.')
  }
  return {
    apiKey: m[1]!,
    apiSecret: m[2]!,
    cloudName: m[3]!,
  }
}

/**
 * Factory provider — instancie le SDK Cloudinary une seule fois et configure
 * les credentials. Le SDK est stateless après config (les méthodes lisent la
 * config globale au moment de l'appel — on peut donc partager un singleton).
 */
@Injectable()
export class CloudinaryClientFactory {
  private readonly logger = new Logger(CloudinaryClientFactory.name)

  build(): CloudinaryClient {
    const env = loadEnv()
    if (!env.CLOUDINARY_URL) {
      // Le superRefine env crash déjà si FF_PHOTOS_ENABLED=true sans URL.
      // Ici on autorise un module Photos chargé mais inactif (FF off) — pas d'effet
      // tant qu'aucun controller n'est appelé.
      this.logger.warn('photos.cloudinary.url_missing_module_inactive')
      return new CloudinaryClient(null)
    }

    const parsed = parseCloudinaryUrl(env.CLOUDINARY_URL)
    // On ne passe PAS `cloudinary_url` au SDK (il lit `process.env` directement
    // sinon, on évite la dépendance globale au process). On passe les credentials
    // structurés ; on garde le `secure: true` (https only).
    cloudinary.config({
      cloud_name: parsed.cloudName,
      api_key: parsed.apiKey,
      api_secret: parsed.apiSecret,
      secure: true,
    })

    this.logger.log(
      `Cloudinary SDK initialisé — cloud=${parsed.cloudName} env=${env.APP_ENV} folderPrefix=${env.CLOUDINARY_FOLDER_PREFIX}`,
    )

    return new CloudinaryClient(parsed)
  }
}

/**
 * Wrapper typé autour du SDK Cloudinary v2. Toutes les méthodes sont
 * dépendantes de la `config` globale du SDK (`v2.config({...})`) — la factory
 * la pose au boot.
 */
export class CloudinaryClient {
  private readonly logger = new Logger(CloudinaryClient.name)

  constructor(private readonly config: CloudinaryConfig | null) {}

  /** Indique si le client est prêt à signer (config présente). */
  isReady(): boolean {
    return this.config !== null
  }

  /**
   * Calcule la signature et compose les paramètres à transmettre au mobile.
   *
   * Stratégie HMAC :
   *  - Cloudinary signe SHA-1 sur la chaîne `param1=val1&param2=val2&...` triée
   *    alphabétiquement + suffixée par `api_secret`.
   *  - On utilise le helper officiel `cloudinary.v2.utils.api_sign_request`
   *    (rule securite : on ne réinvente pas la crypto).
   *  - Les paramètres signés incluent `public_id`, `folder`, `timestamp`, `type`.
   *    Tout autre paramètre transmis dans le multipart par le mobile **non signé**
   *    est rejeté par Cloudinary.
   */
  signUploadParams(input: {
    folder: string
    publicId: string
    mimeType: string
    maxBytes: number
    timestamp?: number
  }): CloudinarySignedUploadParams {
    const cfg = this.requireConfig()
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
    const paramsToSign: Record<string, string | number> = {
      folder: input.folder,
      public_id: input.publicId,
      timestamp,
      type: 'private',
    }

    const signature = cloudinary.utils.api_sign_request(paramsToSign, cfg.apiSecret)
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`

    return {
      uploadUrl,
      cloudName: cfg.cloudName,
      apiKey: cfg.apiKey,
      publicId: input.publicId,
      folder: input.folder,
      type: 'private',
      timestamp,
      signature,
      signatureAlgorithm: 'sha1',
      mimeType: input.mimeType,
      maxBytes: input.maxBytes,
    }
  }

  /**
   * Vérifie qu'une ressource Cloudinary existe avec le `public_id` attendu.
   *
   * Sécurité (`confirm` côté `PhotosService`) : le mobile peut potentiellement
   * mentir sur le `public_id` qu'il prétend avoir uploadé. On re-fetch côté
   * Cloudinary pour valider l'existence + récupérer width/height/bytes
   * (source de vérité serveur).
   */
  async getResource(publicId: string): Promise<CloudinaryResource> {
    this.requireConfig()
    try {
      const r = await cloudinary.api.resource(publicId, {
        type: 'private',
        resource_type: 'image',
      })
      return {
        publicId: r.public_id,
        format: r.format,
        bytes: r.bytes,
        width: r.width,
        height: r.height,
        version: r.version,
        resourceType: r.resource_type,
        type: r.type as 'private',
      }
    } catch (err) {
      const e = err as { http_code?: number; message?: string }
      if (e.http_code === 404) {
        throw new CloudinaryResourceNotFoundError(publicId)
      }
      this.logger.warn(
        {
          publicId,
          httpCode: e.http_code ?? null,
          message: e.message ?? 'unknown',
        },
        'photos.cloudinary.get_resource_failed',
      )
      throw new CloudinaryApiError(e.http_code ?? null, e.message ?? 'cloudinary_error')
    }
  }

  /**
   * Compose une URL signée de lecture (5 min par défaut — utilisé Ticket 3.4).
   * Aucun appel réseau : la signature est calculée localement.
   */
  signedReadUrl(publicId: string, ttlSeconds: number): {
    readonly url: string
    readonly expiresAt: Date
  } {
    this.requireConfig()
    const expiresUnix = Math.floor(Date.now() / 1000) + ttlSeconds
    const url = cloudinary.url(publicId, {
      type: 'private',
      sign_url: true,
      secure: true,
      expires_at: expiresUnix,
    })
    return { url, expiresAt: new Date(expiresUnix * 1000) }
  }

  /**
   * Hash SHA-256 d'un token opaque. Utilisé par `PhotoSessionService` pour
   * stocker `tokenDigest` au lieu du token clair (rule photos-rgpd).
   */
  static digestToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private requireConfig(): CloudinaryConfig {
    if (!this.config) {
      throw new Error(
        'Cloudinary client not configured — assert FF_PHOTOS_ENABLED=true + CLOUDINARY_URL avant usage.',
      )
    }
    return this.config
  }
}
