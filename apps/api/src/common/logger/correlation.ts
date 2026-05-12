/**
 * Helpers de corrélation logs (PRD-004 Ticket 4.1 — Build A2).
 *
 * `traceId` : récupéré depuis le span actif géré par `@sentry/node` v8
 * (qui embarque OpenTelemetry sous le capot). Si aucun span n'est actif
 * (job BullMQ hors HTTP, boot, tests), retourne `undefined`.
 *
 * `requestId` : posé par `RequestIdMiddleware` (A1) sur `req.requestId`.
 * Ce module ne le récupère pas directement — Pino utilise `genReqId` qui
 * lit `req.requestId` côté `pinoHttp` config.
 *
 * Build A3+ pourra brancher OTel custom (cross-process BullMQ) ;
 * l'API publique de ce module reste stable.
 */

import * as Sentry from '@sentry/node'

/**
 * Retourne le traceId du span actif au moment de l'appel, ou `undefined`
 * hors contexte tracé. Robuste : tout throw downstream est silencé
 * (le logging ne doit jamais faire crasher la requête).
 */
export function getCurrentTraceId(): string | undefined {
  try {
    const span = Sentry.getActiveSpan()
    if (!span) return undefined
    const ctx = span.spanContext()
    if (!ctx || ctx.traceId === '00000000000000000000000000000000') {
      return undefined
    }
    return ctx.traceId
  } catch {
    return undefined
  }
}
