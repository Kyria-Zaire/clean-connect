/**
 * Génération / vérification des tokens :
 *  - access  : JWT signé `JWT_ACCESS_SECRET` (stateless, court — 15 min par défaut).
 *  - refresh : chaîne opaque base64url (48 octets random) — stockée HASHÉE en DB
 *              (`sha256(token)` hex 64 caractères) — décrit dans ADR-004.
 *
 * Aucune valeur de token (clair OU hash) ne doit être loguée — cf. règles sécurité PRD-001.
 */

import * as crypto from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Role } from '@prisma/client'

import { loadEnv } from '../../../common/config/env'
import type { JwtAccessPayload } from '../types/jwt-payload.type'

const REFRESH_TOKEN_BYTES = 48

export interface AccessTokenIssued {
  token: string
  jti: string
  expiresInSeconds: number
}

export interface RefreshTokenIssued {
  /** Valeur opaque retournée au client (jamais persistée en clair). */
  token: string
  /** Hash sha256 hex 64 caractères — clé de lookup côté DB. */
  tokenHash: string
  /** Date d'expiration absolue. */
  expiresAt: Date
}

@Injectable()
export class TokenService {
  private readonly env = loadEnv()

  constructor(private readonly jwt: JwtService) {}

  async issueAccessToken(params: { userId: string; role: Role }): Promise<AccessTokenIssued> {
    const jti = crypto.randomUUID()
    const token = await this.jwt.signAsync(
      { sub: params.userId, role: params.role, jti },
      {
        secret: this.env.JWT_ACCESS_SECRET,
        expiresIn: this.env.JWT_ACCESS_EXPIRES_IN,
      },
    )
    const decoded = this.jwt.decode(token) as { exp?: number; iat?: number } | null
    const expiresInSeconds =
      decoded?.exp && decoded.iat ? decoded.exp - decoded.iat : this.fallbackAccessTtlSeconds()
    return { token, jti, expiresInSeconds }
  }

  async verifyAccessToken(token: string): Promise<JwtAccessPayload> {
    return this.jwt.verifyAsync<JwtAccessPayload>(token, {
      secret: this.env.JWT_ACCESS_SECRET,
    })
  }

  issueRefreshToken(): RefreshTokenIssued {
    const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
    return {
      token: raw,
      tokenHash: this.hashRefreshToken(raw),
      expiresAt: this.computeRefreshExpiresAt(),
    }
  }

  hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  private computeRefreshExpiresAt(): Date {
    const ms = this.parseDurationMs(this.env.JWT_REFRESH_EXPIRES_IN)
    return new Date(Date.now() + ms)
  }

  private fallbackAccessTtlSeconds(): number {
    return Math.floor(this.parseDurationMs(this.env.JWT_ACCESS_EXPIRES_IN) / 1000)
  }

  /**
   * Parse les durées Nest/JWT classiques : `15m`, `30d`, `12h`, `45s` ou nombre brut en secondes.
   * Limité à ces unités — pas de notation libre type `1d2h`.
   */
  private parseDurationMs(value: string): number {
    const match = /^(\d+)\s*([smhd])?$/u.exec(value.trim())
    if (!match) {
      throw new Error(`Durée invalide pour JWT_*_EXPIRES_IN : "${value}"`)
    }
    const amount = Number(match[1])
    const unit = match[2] ?? 's'
    const unitMs: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    }
    const factor = unitMs[unit]
    if (factor === undefined) {
      throw new Error(`Unité inconnue pour JWT_*_EXPIRES_IN : "${value}"`)
    }
    return amount * factor
  }
}
