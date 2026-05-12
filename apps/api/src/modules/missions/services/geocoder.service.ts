/**
 * GeocoderService — adresse FR → coordonnées WGS84 via BAN (Discover Q3 + ADR-006).
 *
 * Pattern obligatoire (skill integrate-external-service + rule securite) :
 *  - timeout (`AbortSignal.timeout`)
 *  - retry exponentiel borné
 *  - fallback géré côté caller (mobile peut envoyer la position GPS)
 *  - logs structurés sans PII (rule securite)
 *
 * NB : Prisma ne sait pas écrire `geography(Point, 4326)` directement (cf.
 * ADR-003) — l'écriture finale est faite par `MissionsRepository.createWithLocation`
 * via `$executeRaw` après obtention des coordonnées.
 */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import type { Env } from '../../../common/config/env'

export interface GeocodeInput {
  street: string
  city: string
  zipCode: string
  /** Bypass BAN si fourni (fallback mobile GPS). */
  knownLocation?: { lat: number; lng: number }
}

export interface GeocodeResult {
  lat: number
  lng: number
  /** Source utilisée pour traçabilité (audit / metrics). */
  source: 'BAN' | 'CLIENT_GPS'
}

interface BanFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: { score?: number }
}

interface BanResponse {
  features?: BanFeature[]
}

@Injectable()
export class GeocoderService {
  private readonly logger = new Logger(GeocoderService.name)
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly config: ConfigService<Env, true>) {
    this.baseUrl = this.config.get('BAN_BASE_URL', { infer: true })
    this.timeoutMs = this.config.get('BAN_TIMEOUT_MS', { infer: true })
  }

  async geocode(input: GeocodeInput): Promise<GeocodeResult> {
    if (input.knownLocation) {
      return { ...input.knownLocation, source: 'CLIENT_GPS' }
    }
    const banResult = await this.callBan(input)
    return { ...banResult, source: 'BAN' }
  }

  private async callBan(input: GeocodeInput): Promise<{ lat: number; lng: number }> {
    const query = `${input.street}, ${input.zipCode} ${input.city}`
    const url = new URL('/search/', this.baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '1')
    url.searchParams.set('postcode', input.zipCode)

    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { 'User-Agent': 'CleanConnect/0.2 (contact@cleanconnect.fr)' },
        })
        if (!response.ok) {
          throw new Error(`BAN HTTP ${response.status}`)
        }
        const json = (await response.json()) as BanResponse
        const feat = json.features?.[0]
        const coords = feat?.geometry?.coordinates
        if (!coords || coords.length !== 2) {
          throw new Error('BAN no_match')
        }
        const [lng, lat] = coords
        if (typeof lng !== 'number' || typeof lat !== 'number') {
          throw new Error('BAN invalid_coords')
        }
        return { lat, lng }
      } catch (err) {
        lastError = err
        // Log non-PII : on n'enregistre que la tentative et le code postal (zone publique).
        this.logger.warn({
          event: 'geocoder.ban.failure',
          attempt,
          zipCode: input.zipCode,
          err: this.scrubError(err),
        })
        const delay = 200 * attempt
        await new Promise((r) => setTimeout(r, delay))
      }
    }

    throw new Error(
      `GeocoderService: BAN unreachable after retries — ${
        lastError instanceof Error ? lastError.message : 'unknown'
      }`,
    )
  }

  private scrubError(err: unknown): { name: string; message?: string } {
    if (err instanceof Error) return { name: err.name, message: err.message }
    return { name: 'UnknownError' }
  }
}
