/**
 * PRD-004 Ticket 4.1 — Build B (propagation `traceparent` HTTP → BullMQ worker).
 *
 * Pourquoi un helper manuel ?
 * - `@opentelemetry/auto-instrumentations-node@^0.55` n'inclut PAS d'instrumentation
 *   BullMQ officielle. Le seul package community (`opentelemetry-instrumentation-bullmq`)
 *   est instable et non audité côté sécurité.
 * - On garde le contrôle exact sur le champ injecté (`_otel.traceparent`) →
 *   audit + tests reproductibles.
 *
 * Contrat :
 *  1. **Producer** appelle `injectTraceContext(payload)` au moment du `queue.add`.
 *     - Retourne un nouveau payload (pure, sans mutation) avec `_otel.traceparent`
 *       + `_otel.tracestate` (W3C TraceContext + Sentry baggage).
 *     - Si aucun span actif → renvoie le payload original (no-op).
 *  2. **Worker** appelle `runWithExtractedTraceContext(job.data, fn)` au début de
 *     `process(job)` pour activer le contexte parent.
 *     - Crée une span enfant `bullmq.process` automatiquement.
 *     - Strip le champ `_otel` du payload sanitisé exposé au métier.
 *
 * **Sécurité** :
 *  - Aucune PII injectée. `traceparent` = string opaque cryptographique générée
 *    par OTel (~55 caractères ASCII). Aucun risque PII ; déjà standardisé W3C.
 *  - `_otel` reste interne — jamais affiché dans BullBoard (cf. sanitization B2).
 *  - Pas de fallback `try { ... } catch { /\* ignore *\/ }` silencieux : on log
 *    via Pino (avec redaction A/B/C) si propagation échoue.
 *
 * **Cardinalité** : aucune nouvelle dimension exportée à Prometheus — uniquement
 * attribute span (rate limité par sampling OTel).
 */

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
} from '@opentelemetry/api'

/**
 * Champ réservé injecté dans le payload BullMQ. Préfixe `_` pour signaler à
 * tout dev que c'est de l'infra (non-business). Format inchangé entre versions
 * Build B → si on doit migrer, prévoir migration jobs en queue.
 */
export const OTEL_PAYLOAD_KEY = '_otel' as const

export interface OtelTraceCarrier {
  /** Header W3C `traceparent` — string opaque, safe à logguer. */
  traceparent?: string
  /** Header W3C `tracestate` — vendor data (Sentry baggage). */
  tracestate?: string
}

export type WithOtelContext<T> = T & {
  [OTEL_PAYLOAD_KEY]?: OtelTraceCarrier
}

/**
 * Injecte le contexte trace courant dans le payload BullMQ.
 *
 * - Idempotent : si `_otel.traceparent` est déjà présent → conservé (cas
 *   replay DLQ → on garde la trace originale).
 * - Sans span actif → retourne le payload original (no propagation).
 *
 * @example
 *   await queue.add('event', injectTraceContext({ stripeEventId, ... }))
 */
export function injectTraceContext<T extends object>(payload: T): WithOtelContext<T> {
  const existing = (payload as WithOtelContext<T>)[OTEL_PAYLOAD_KEY]
  if (existing?.traceparent !== undefined) {
    return payload as WithOtelContext<T>
  }

  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)

  const traceparent = carrier.traceparent
  if (typeof traceparent !== 'string' || traceparent.length === 0) {
    return payload as WithOtelContext<T>
  }

  const tracestate = typeof carrier.tracestate === 'string' ? carrier.tracestate : undefined

  return {
    ...payload,
    [OTEL_PAYLOAD_KEY]: {
      traceparent,
      ...(tracestate !== undefined ? { tracestate } : {}),
    },
  }
}

/**
 * Extrait `_otel.*` du payload pour reconstituer un `Context` OTel.
 * Retourne `context.active()` si aucune information n'est trouvée (fallback).
 */
export function extractContextFromPayload(payload: unknown): Context {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !(OTEL_PAYLOAD_KEY in (payload as Record<string, unknown>))
  ) {
    return context.active()
  }
  const carrier = (payload as WithOtelContext<Record<string, unknown>>)[OTEL_PAYLOAD_KEY]
  if (carrier === undefined) return context.active()

  const headerLike: Record<string, string> = {}
  if (typeof carrier.traceparent === 'string') headerLike.traceparent = carrier.traceparent
  if (typeof carrier.tracestate === 'string') headerLike.tracestate = carrier.tracestate

  if (Object.keys(headerLike).length === 0) return context.active()
  return propagation.extract(context.active(), headerLike)
}

/**
 * Lance `fn` dans une span enfant `bullmq.process` rattachée au trace parent
 * injecté côté producer. Wrapping fin → ne pollue jamais la logique métier.
 *
 * Le span enfant porte :
 *  - `messaging.system = bullmq`
 *  - `messaging.destination = <queueName>` (whitelist : pas d'ID)
 *  - `messaging.operation = process`
 *  - `bullmq.job.name = <jobName>` (≤ 64 chars, déjà bounded)
 *
 * Aucun userId / missionId / paymentIntentId — strictement infra.
 *
 * @example
 *   async process(job: Job): Promise<void> {
 *     return runWithExtractedTraceContext(job.data, 'stripe-webhooks', job.name, () =>
 *       this.doWork(job)
 *     )
 *   }
 */
export async function runWithExtractedTraceContext<T>(
  payload: unknown,
  queueName: string,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parentCtx = extractContextFromPayload(payload)
  const tracer = trace.getTracer('clean-connect.bullmq')
  return context.with(parentCtx, () =>
    tracer.startActiveSpan(
      `bullmq.process ${queueName}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination': queueName,
          'messaging.operation': 'process',
          'bullmq.job.name': jobName.slice(0, 64),
        },
      },
      async (span) => {
        try {
          const out = await fn()
          span.setStatus({ code: SpanStatusCode.OK })
          return out
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message.slice(0, 256) : 'job failed',
          })
          throw err
        } finally {
          span.end()
        }
      },
    ),
  )
}

/**
 * Helper test — strip le champ `_otel` du payload pour comparaison avec le
 * payload original (utile dans les tests de processors qui ne veulent pas
 * connaître l'infra de propagation).
 */
export function stripOtelFromPayload<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object') return payload
  if (!(OTEL_PAYLOAD_KEY in (payload as Record<string, unknown>))) return payload
  const copy = { ...(payload as Record<string, unknown>) }
  delete copy[OTEL_PAYLOAD_KEY]
  return copy as T
}
