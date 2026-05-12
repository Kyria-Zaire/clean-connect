/**
 * Normalisation des routes pour labels Prometheus (PRD-004 Ticket 4.1 — A3).
 *
 * Objectif : transformer `/api/v1/payments/abc-123-def` en
 * `/api/v1/payments/:id` pour borner la cardinalité (cf. règle ADR-014 §2.6).
 *
 * Stratégie :
 * 1. Si Express a matché un handler, `req.route?.path` donne le pattern
 *    relatif au router (ex: `/:id`). On le combine avec `req.baseUrl` pour
 *    obtenir le chemin complet.
 * 2. Sinon (404, options preflight, route hors Nest), on tombe en fallback
 *    `__unmatched__` — borne dure à une seule série par méthode/status.
 *
 * On **n'essaie pas** de regex-replace les UUIDs à la main : trop de faux
 * positifs (mission codes, slugs). Express a déjà le pattern. Si ce n'est
 * pas dispo, on assume route inconnue → mieux que cardinalité explosive.
 */

import type { Request } from 'express'

const FALLBACK_ROUTE = '__unmatched__'

/**
 * Type partial extrait du runtime Express — `req.route` n'est ajouté par
 * Express qu'après matching du router (peut être `undefined`).
 */
interface ExpressRouteShape {
  path?: string
}

export function normalizeRoute(req: Request): string {
  const route = (req as { route?: ExpressRouteShape }).route
  const path = route?.path
  if (typeof path !== 'string' || path.length === 0) {
    return FALLBACK_ROUTE
  }
  const baseUrl = req.baseUrl ?? ''
  const full = `${baseUrl}${path}`
  return full.length > 0 ? full : FALLBACK_ROUTE
}
