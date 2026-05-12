/**
 * PRD-004 Ticket 4.1 — Build B (OpenTelemetry SDK bootstrap).
 *
 * Source de vérité : ADR-014 §2.5 (traces distribuées) + cahier CTO Build B.
 *
 * Responsabilités :
 *  1. Initialiser un `NodeSDK` OTel **avant** Nest/Sentry/Express → pour que
 *     les auto-instrumentations attachent `http`, `express`, `ioredis`, `pg`,
 *     `pino`, etc. (le require-hook OTel ne marche que sur des modules pas
 *     encore chargés).
 *  2. Forwarder les spans à Sentry via `SentrySpanProcessor` (Sentry v8 utilise
 *     OTel sous le capot — on lui demande de skip son setup OTel pour éviter
 *     la double registration et on ré-attache ici).
 *  3. Utiliser `SentryPropagator` pour la propagation `traceparent` + Sentry
 *     baggage compatible avec les services Sentry tiers.
 *  4. Exposer un helper de shutdown pour `app.enableShutdownHooks()` Nest.
 *
 * **Découplage métier** : ce module ne touche jamais aux services Payments /
 * Photos / Auth. Les seuls hooks métier sont les helpers de propagation BullMQ
 * (`bullmq-trace.ts`) appelés explicitement côté producer + processor.
 *
 * **Sécurité** :
 *  - `@opentelemetry/api` ne loggue jamais les bodies HTTP par défaut.
 *  - On désactive `instrumentation-fs` (peut log des paths sensibles type
 *    secrets/clés Cloudinary).
 *  - On désactive `instrumentation-dns` (cardinalité explosive sur Redis).
 *  - Aucune injection de header custom (jamais Authorization en attribut span).
 */

import process from 'node:process'

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  SemanticResourceAttributes,
} from '@opentelemetry/semantic-conventions'
import { SentryPropagator, SentrySpanProcessor } from '@sentry/opentelemetry'

/**
 * État global du SDK — `null` tant qu'aucun bootstrap n'a réussi.
 * On l'expose pour les tests + les shutdown hooks Nest.
 */
let activeSdk: NodeSDK | null = null

export interface OtelBootstrapOptions {
  enabled: boolean
  serviceName: string
  serviceVersion: string
  environment: string
  /** URL OTLP/HTTP collector — undefined ⇒ fallback console exporter en dev. */
  otlpEndpoint?: string
  /** Verbose `diag` logging — dev only (jamais en prod, pollue stdout). */
  diagVerbose?: boolean
}

/**
 * Bootstrap OTel SDK NodeJS. Idempotent : appels multiples = no-op.
 *
 * Doit être appelé **avant** :
 *  - `Sentry.init()` (qui s'attache ici via SentrySpanProcessor)
 *  - `NestFactory.create()` (qui charge Express → auto-instrumenté ensuite)
 *  - tout `require('http')` côté code utilisateur
 */
export function initOpenTelemetry(opts: OtelBootstrapOptions): NodeSDK | null {
  if (!opts.enabled) {
    return null
  }
  if (activeSdk !== null) {
    return activeSdk
  }

  if (opts.diagVerbose === true) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
  }

  const spanProcessors: SpanProcessor[] = []

  // 1. Sentry processor — forwarde toutes les spans OTel à Sentry (v8).
  //    Nécessite `Sentry.init({skipOpenTelemetrySetup: true})` côté Sentry.
  spanProcessors.push(new SentrySpanProcessor())

  // 2. Exporter principal :
  //    - OTLP/HTTP si `OTEL_EXPORTER_OTLP_ENDPOINT` est défini (Tempo/Jaeger)
  //    - ConsoleSpanExporter sinon (dev uniquement, jamais en prod silencieux)
  if (opts.otlpEndpoint !== undefined && opts.otlpEndpoint.length > 0) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${opts.otlpEndpoint.replace(/\/+$/, '')}/v1/traces`,
          // Aucun header d'auth par défaut — collector intra-réseau Docker.
          // À adapter via env si auth requise (ADR-014 §2.5).
        }),
      ),
    )
  } else if (opts.environment === 'development') {
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()))
  }

  // 3. Resource — étiquette toutes les spans avec service.name/version/env.
  //    Utilisé par Grafana/Tempo pour filtrer + corréler.
  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: opts.serviceVersion,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: opts.environment,
  })

  // 4. Auto-instrumentations — limitées + sécurisées.
  //    - http/express : OK
  //    - ioredis : OK (BullMQ utilise ioredis)
  //    - pg : OK (Prisma utilise pg)
  //    - pino : OK (corrélation traceId injecté automatiquement dans les logs)
  //    - fs / dns : DÉSACTIVÉS (PII / cardinalité explosive — cf. ADR-016)
  const instrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      // On laisse passer les headers Stripe sauf signature/idempotency-key.
      // Anti-PII : Pino redactor s'occupe des bodies, OTel HTTP n'enregistre
      // pas les bodies par défaut, donc safe.
      enabled: true,
      ignoreIncomingRequestHook: (req) => {
        const url = req.url ?? ''
        // Évite de tracer le scrape Prometheus + healthchecks (volume + bruit).
        return (
          url.startsWith('/api/internal/metrics') ||
          url.startsWith('/healthz') ||
          url.startsWith('/readyz')
        )
      },
    },
  })

  activeSdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations,
    // SentryPropagator gère W3C TraceContext + Sentry baggage.
    textMapPropagator: new SentryPropagator(),
  })

  activeSdk.start()

  // SIGTERM / SIGINT graceful flush — nécessaire pour ne pas perdre les
  // dernières spans avant arrêt container.
  process.once('SIGTERM', () => {
    void activeSdk?.shutdown().catch(() => undefined)
  })

  return activeSdk
}

/**
 * Shutdown explicite — utilisé par `enableShutdownHooks()` Nest et par les
 * tests pour éviter les leaks de timer/exporter entre suites.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (activeSdk === null) return
  try {
    await activeSdk.shutdown()
  } finally {
    activeSdk = null
  }
}

/**
 * @internal — réservé tests : reset l'état global pour boot/teardown répétés.
 */
export function __resetOtelStateForTests(): void {
  activeSdk = null
}
