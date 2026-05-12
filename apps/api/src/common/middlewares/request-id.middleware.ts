/**
 * Middleware Express — propagation `requestId` (PRD-004 Ticket 4.1 — Build A1).
 *
 * Génère un `requestId` UUID si absent du header `x-request-id`, attache à
 * `req.requestId`, propage en réponse via `X-Request-Id`, et tag Sentry
 * (scope isolé par requête grâce à l'`httpIntegration` v8).
 *
 * `traceId` (OpenTelemetry) est ajouté en A2 via Pino correlation. En A1 on
 * pose seulement les fondations `requestId`.
 */

import { randomUUID } from 'node:crypto'

import { Injectable, type NestMiddleware } from '@nestjs/common'
import * as Sentry from '@sentry/node'
import type { NextFunction, Request, Response } from 'express'

const HEADER_REQUEST_ID = 'x-request-id'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Request {
      requestId?: string
    }
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER_REQUEST_ID)
    const id = isValidRequestId(incoming) ? incoming : randomUUID()

    req.requestId = id
    res.setHeader('X-Request-Id', id)

    Sentry.getCurrentScope().setTag('requestId', id)

    next()
  }
}

/**
 * Validation conservative : on accepte un header entrant uniquement s'il a
 * une forme « ASCII safe » courte. Sinon on génère un UUID neuf (anti-injection
 * dans les logs / metrics labels).
 */
function isValidRequestId(value: string | undefined): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 128) return false
  return /^[A-Za-z0-9._-]+$/.test(value)
}
