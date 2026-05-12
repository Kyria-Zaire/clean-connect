/**
 * PRD-004 Ticket 4.1 (Build B) — OpenTelemetry pré-bootstrap.
 *
 * **Ce fichier DOIT être importé en TOUT PREMIER** (`import './instrumentation'`
 * au sommet de `main.ts`), sinon les auto-instrumentations Node ne peuvent pas
 * accrocher `http`/`express`/`ioredis`/`pg`/`pino` (require-hook = chargés trop
 * tôt → trop tard pour OTel).
 *
 * Le fichier reste **silencieux** (aucun log stdout) tant que `OTEL_ENABLED=false`
 * (défaut). Aucune dépendance Nest ici — c'est du bootstrap pur.
 */

import { loadEnv } from './common/config/env'
import { initOpenTelemetry } from './modules/observability/tracing/otel.bootstrap'

const env = loadEnv()

initOpenTelemetry({
  enabled: env.OTEL_ENABLED,
  serviceName: env.OTEL_SERVICE_NAME,
  serviceVersion: env.APP_VERSION,
  environment: env.APP_ENV,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  diagVerbose: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace',
})
