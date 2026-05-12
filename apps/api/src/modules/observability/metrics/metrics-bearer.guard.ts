/**
 * MetricsBearerGuard — protection de `GET /api/internal/metrics`
 * (PRD-004 Ticket 4.1 — Build A3).
 *
 * Comparaison `timingSafeEqual` (anti timing-attack) entre le hash SHA-256
 * du token fourni et celui attendu. Refuse explicitement les requêtes :
 * - sans header `Authorization`
 * - avec un schéma autre que `Bearer`
 * - quand `METRICS_BEARER_TOKEN` est absent en config (= métrics désactivées)
 *
 * Le guard fait intentionnellement `false` plutôt que `throw 401` pour ne
 * pas exposer de différence d'erreur entre les cas → réponse uniforme
 * `403 Forbidden` côté Nest.
 *
 * Note : on n'utilise pas `@nestjs/passport` ici — Prometheus scraper n'a
 * pas de JWT user. Un token statique opaque suffit (rotation manuelle).
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'

import { loadEnv } from '../../../common/config/env'

@Injectable()
export class MetricsBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const env = loadEnv()
    if (!env.METRICS_ENABLED) return false
    if (!env.METRICS_BEARER_TOKEN) return false

    const req = context.switchToHttp().getRequest<Request>()
    const auth = req.header('authorization')
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false

    const provided = auth.slice('Bearer '.length).trim()
    if (provided.length === 0) return false

    const providedHash = createHash('sha256').update(provided).digest()
    const expectedHash = createHash('sha256').update(env.METRICS_BEARER_TOKEN).digest()

    return timingSafeEqual(providedHash, expectedHash)
  }
}
