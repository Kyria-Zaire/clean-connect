/**
 * PRD-004 Ticket 4.1 (Build B) — Auth middleware pour BullBoard.
 *
 * Pourquoi un middleware custom et pas `JwtAccessGuard` ?
 *  - BullBoard est monté via Express router (pas un Controller Nest), donc
 *    les guards Nest ne s'appliquent pas naturellement.
 *  - On combine 2 mécanismes :
 *      1. JWT ADMIN (cohérent avec le reste de l'API)
 *      2. INTERNAL_BEARER_TOKEN (firewall intra-réseau, defense-in-depth)
 *    Le token interne est validé en `timingSafeEqual` pour éviter timing attacks.
 *
 * Réponses d'erreur :
 *  - `401 { error: 'UNAUTHORIZED' }` si aucun header `Authorization` valide
 *  - `403 { error: 'FORBIDDEN' }` si JWT valide mais role !== ADMIN
 *
 * Aucune fuite : on ne log JAMAIS le token rejected. Audit Pino sur outcomes only.
 */

import { timingSafeEqual } from 'node:crypto'

import { Injectable, Logger, type NestMiddleware } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Role } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'

import { loadEnv, type Env } from '../../../common/config/env'

export interface BullBoardJwtPayload {
  sub: string
  role: Role
  jti?: string
  iat?: number
  exp?: number
}

@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BullBoardAuthMiddleware.name)
  private readonly env: Env

  constructor(private readonly jwt: JwtService) {
    this.env = loadEnv()
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization
    if (typeof header !== 'string' || header.length < 8) {
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return
    }
    const [scheme, raw] = header.split(' ', 2)
    if (scheme !== 'Bearer' || typeof raw !== 'string' || raw.length === 0) {
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return
    }

    // Voie 1 — INTERNAL_BEARER_TOKEN (scrape ops / firewall interne).
    //          timingSafeEqual évite les timing attacks (rule securite).
    if (this.env.INTERNAL_BEARER_TOKEN !== undefined) {
      try {
        const a = Buffer.from(raw, 'utf8')
        const b = Buffer.from(this.env.INTERNAL_BEARER_TOKEN, 'utf8')
        if (a.length === b.length && timingSafeEqual(a, b)) {
          this.logger.debug({ route: req.path }, 'bullboard.auth.internal_bearer_ok')
          return next()
        }
      } catch {
        // fall-through
      }
    }

    // Voie 2 — JWT ADMIN. On utilise verify() avec le secret access (cohérent
    //          avec JwtAccessStrategy mais sans dépendance Passport).
    try {
      const payload = this.jwt.verify<BullBoardJwtPayload>(raw, {
        secret: this.env.JWT_ACCESS_SECRET,
      })
      if (payload.role !== Role.ADMIN) {
        res.status(403).json({ error: 'FORBIDDEN' })
        return
      }
      this.logger.debug({ route: req.path, userId: payload.sub }, 'bullboard.auth.jwt_ok')
      return next()
    } catch {
      res.status(401).json({ error: 'UNAUTHORIZED' })
    }
  }
}
