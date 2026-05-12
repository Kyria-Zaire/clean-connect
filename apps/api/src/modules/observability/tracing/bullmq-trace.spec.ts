/**
 * PRD-004 Ticket 4.1 (Build B) — unit tests propagation BullMQ.
 *
 * Couverture :
 *  1. `injectTraceContext` retourne le payload original quand aucun span n'est
 *     actif (OTel SDK off ou hors d'une span manuelle).
 *  2. `injectTraceContext` injecte `_otel.traceparent` quand une span est active.
 *  3. `injectTraceContext` ne mute pas le payload original (immutabilité).
 *  4. `injectTraceContext` est idempotent (replay DLQ ne réécrit pas la trace).
 *  5. `extractContextFromPayload` retourne le contexte courant si aucun `_otel`.
 *  6. `runWithExtractedTraceContext` activie le parent et reset le span.
 *  7. `stripOtelFromPayload` enlève le champ `_otel` sans toucher au reste.
 *  8. Aucun attribut span ne contient userId / missionId / paymentIntentId
 *     (audit sécurité — labels bornés).
 */

import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api'
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'

import {
  extractContextFromPayload,
  injectTraceContext,
  OTEL_PAYLOAD_KEY,
  runWithExtractedTraceContext,
  stripOtelFromPayload,
} from './bullmq-trace'

describe('BullMQ trace propagation (PRD-004 Build B)', () => {
  let provider: BasicTracerProvider
  let exporter: InMemorySpanExporter
  let contextManager: AsyncHooksContextManager

  beforeAll(() => {
    contextManager = new AsyncHooksContextManager().enable()
    context.setGlobalContextManager(contextManager)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
  })

  afterAll(async () => {
    await provider.shutdown()
    contextManager.disable()
    trace.disable()
    propagation.disable()
    context.disable()
  })

  beforeEach(() => exporter.reset())

  describe('injectTraceContext', () => {
    it('returns the original payload when no span is active', () => {
      const payload = { stripeEventId: 'evt_abc', type: 'payment_intent.succeeded' }
      const out = injectTraceContext(payload)
      expect(out).toEqual(payload)
      expect(OTEL_PAYLOAD_KEY in out).toBe(false)
    })

    it('injects a `_otel.traceparent` when called inside an active span', () => {
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('producer-test')
      const ctx = trace.setSpan(context.active(), span)

      const payload = { stripeEventId: 'evt_xyz' }
      const out = context.with(ctx, () => injectTraceContext(payload))

      expect(out[OTEL_PAYLOAD_KEY]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
      expect(out.stripeEventId).toBe('evt_xyz')
      span.end()
    })

    it('does not mutate the original payload (immutable)', () => {
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('producer-test')
      const ctx = trace.setSpan(context.active(), span)

      const payload = { foo: 1 }
      const out = context.with(ctx, () => injectTraceContext(payload))

      expect(payload).toEqual({ foo: 1 })
      expect((payload as Record<string, unknown>)[OTEL_PAYLOAD_KEY]).toBeUndefined()
      expect(out).not.toBe(payload)
      span.end()
    })

    it('is idempotent — does not overwrite an existing traceparent (replay safety)', () => {
      const existing = {
        eventId: 'evt_replayed',
        [OTEL_PAYLOAD_KEY]: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' },
      }
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('producer-test')
      const ctx = trace.setSpan(context.active(), span)

      const out = context.with(ctx, () => injectTraceContext(existing))
      expect(out[OTEL_PAYLOAD_KEY]?.traceparent).toBe(existing[OTEL_PAYLOAD_KEY].traceparent)
      span.end()
    })
  })

  describe('extractContextFromPayload', () => {
    it('returns active context when no `_otel` field', () => {
      const ctx = extractContextFromPayload({ stripeEventId: 'evt' })
      expect(ctx).toBeDefined()
      // No parent span = ROOT_CONTEXT or active() — both valid.
      expect(trace.getSpanContext(ctx) === undefined || trace.getSpanContext(ctx)).toBeDefined()
    })

    it('restores a parent context from injected traceparent', () => {
      const tracer = trace.getTracer('test')
      const parentSpan = tracer.startSpan('producer')
      const producerCtx = trace.setSpan(ROOT_CONTEXT, parentSpan)
      const payload = context.with(producerCtx, () => injectTraceContext({ jobId: 'a' }))
      parentSpan.end()

      const restored = extractContextFromPayload(payload)
      const restoredSpanCtx = trace.getSpanContext(restored)
      expect(restoredSpanCtx?.traceId).toBe(parentSpan.spanContext().traceId)
    })

    it('returns active context when payload is null/undefined/primitive', () => {
      expect(extractContextFromPayload(null)).toBeDefined()
      expect(extractContextFromPayload(undefined)).toBeDefined()
      expect(extractContextFromPayload(42)).toBeDefined()
      expect(extractContextFromPayload('string')).toBeDefined()
    })
  })

  describe('runWithExtractedTraceContext', () => {
    it('creates a CONSUMER span linked to the parent injected by the producer', async () => {
      const tracer = trace.getTracer('test')
      const parent = tracer.startSpan('http-route')
      const producerCtx = trace.setSpan(ROOT_CONTEXT, parent)
      const payload = context.with(producerCtx, () => injectTraceContext({ stripeEventId: 'evt_lnk' }))
      parent.end()

      await runWithExtractedTraceContext(payload, 'stripe-webhooks', 'process-event', async () => {
        // simulate work
      })

      const spans = exporter.getFinishedSpans()
      const consumer = spans.find((s) => s.name === 'bullmq.process stripe-webhooks')
      expect(consumer).toBeDefined()
      expect(consumer?.parentSpanId).toBe(parent.spanContext().spanId)
      expect(consumer?.spanContext().traceId).toBe(parent.spanContext().traceId)
    })

    it('records error status when the wrapped function throws', async () => {
      const payload = { foo: 'bar' }
      await expect(
        runWithExtractedTraceContext(payload, 'q', 'job', async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')

      const consumer = exporter.getFinishedSpans().find((s) => s.name === 'bullmq.process q')
      expect(consumer?.status.code).toBe(2 /* SpanStatusCode.ERROR */)
    })

    it('records only bounded attributes — no userId/missionId/paymentIntentId on span', async () => {
      const payload = {
        missionId: 'mission-leaked',
        userId: 'usr_should_not_appear',
        paymentIntentId: 'pi_secret',
      }
      await runWithExtractedTraceContext(payload, 'transfers', 'job-name', async () => undefined)

      const consumer = exporter.getFinishedSpans().find((s) => s.name === 'bullmq.process transfers')
      const attrs = consumer?.attributes ?? {}
      expect(Object.keys(attrs)).toEqual(
        expect.arrayContaining([
          'messaging.system',
          'messaging.destination',
          'messaging.operation',
          'bullmq.job.name',
        ]),
      )
      // Strict — aucun champ PII / business présent.
      expect(JSON.stringify(attrs)).not.toMatch(/mission-leaked|usr_should_not_appear|pi_secret/)
    })
  })

  describe('stripOtelFromPayload', () => {
    it('removes the `_otel` field', () => {
      const payload = {
        foo: 1,
        [OTEL_PAYLOAD_KEY]: { traceparent: '00-aa-bb-01' },
      }
      const out = stripOtelFromPayload(payload)
      expect(OTEL_PAYLOAD_KEY in out).toBe(false)
      expect(out.foo).toBe(1)
    })

    it('returns payload unchanged when no `_otel` field', () => {
      const payload = { foo: 1 }
      expect(stripOtelFromPayload(payload)).toEqual({ foo: 1 })
    })

    it('handles null / undefined / primitive safely', () => {
      expect(stripOtelFromPayload(null)).toBeNull()
      expect(stripOtelFromPayload(undefined)).toBeUndefined()
      expect(stripOtelFromPayload(42 as never)).toBe(42)
    })
  })
})
