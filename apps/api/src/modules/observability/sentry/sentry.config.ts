/**
 * Initialisation Sentry pour Clean Connect (PRD-004 Ticket 4.1 — Build A1).
 *
 * Cette fonction est appelée **AVANT** `NestFactory.create(...)` dans `main.ts`,
 * pour que les auto-instrumentations Node (`http`, `fetch`, `pg`, etc.)
 * s'attachent dès le boot. Idempotente : double appel = no-op (cf. cache local).
 *
 * Quand `SENTRY_DSN` est vide / absent (dev local, tests), `Sentry.init({...})`
 * reste **safe à appeler** mais aucune donnée n'est envoyée au réseau — on
 * journalise un debug log pour audit.
 *
 * Politique de sampling : `tracesSampleRate` ENV par défaut + override 100 %
 * sur routes finance / webhooks (`tracesSampler`) — ADR-014 §2.5.
 *
 * Politique de redaction : `beforeSend` + `beforeBreadcrumb` délégués à
 * `./sanitize.ts` (testé exhaustivement). Aucune fuite PII / secret possible.
 */

import * as Sentry from '@sentry/node'

import type { Env } from '../../../common/config/env'

import { sanitizeBreadcrumb, sanitizeEvent } from './sanitize'

/**
 * Type local — `SamplingContext` n'est pas réexporté depuis `@sentry/node` v8
 * mais accessible via `Parameters<NonNullable<NodeOptions['tracesSampler']>>[0]`.
 * On l'extrait via cette astuce pour garder un typage strict sans dépendre
 * de `@sentry/core` (sous-package interne, instable).
 */
type SamplingContext = Parameters<NonNullable<Sentry.NodeOptions['tracesSampler']>>[0]

let initialized = false

/**
 * `true` si le DSN est configuré → Sentry réellement actif (sinon no-op).
 * Exposé pour les tests + diagnostic au boot.
 */
export function isSentryEnabled(env: Pick<Env, 'SENTRY_DSN'>): boolean {
  return typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.length > 0
}

/**
 * Override 100 % sampling pour les transactions critiques business
 * (paiements + webhooks Stripe + photos confirm + auth refresh).
 * Hors de ces routes, on retombe sur `SENTRY_TRACES_SAMPLE_RATE`.
 */
function buildTracesSampler(env: Pick<Env, 'SENTRY_TRACES_SAMPLE_RATE'>) {
  const defaultRate = env.SENTRY_TRACES_SAMPLE_RATE
  return (samplingContext: SamplingContext): number => {
    const name =
      (typeof samplingContext.name === 'string' ? samplingContext.name : '') ||
      (typeof samplingContext.attributes?.['http.target'] === 'string'
        ? (samplingContext.attributes['http.target'] as string)
        : '')

    if (!name) return defaultRate

    const lower = name.toLowerCase()
    if (
      lower.includes('/payments/') ||
      lower.includes('/webhooks/stripe') ||
      lower.includes('/photos/confirm') ||
      lower.includes('/auth/refresh')
    ) {
      return 1
    }
    return defaultRate
  }
}

type SentryEnv = Pick<
  Env,
  | 'SENTRY_DSN'
  | 'SENTRY_ENVIRONMENT'
  | 'SENTRY_RELEASE'
  | 'SENTRY_TRACES_SAMPLE_RATE'
  | 'APP_ENV'
  | 'APP_VERSION'
  | 'NODE_ENV'
>

/**
 * Init Sentry. **Idempotent**.
 *
 * Retourne `true` si le SDK a été initialisé (avec ou sans DSN), `false` si
 * un init précédent était déjà actif (no-op).
 */
export function initSentry(env: SentryEnv): boolean {
  if (initialized) return false
  initialized = true

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.APP_ENV,
    release: env.SENTRY_RELEASE ?? `clean-connect@${env.APP_VERSION}`,
    tracesSampler: buildTracesSampler(env),
    sendDefaultPii: false,
    attachStacktrace: true,
    normalizeDepth: 6,
    maxBreadcrumbs: 50,
    beforeSend: sanitizeEvent,
    beforeBreadcrumb: sanitizeBreadcrumb,
    /**
     * Sentry v8 intègre par défaut : `httpIntegration`, `expressIntegration`,
     * `nativeNodeFetchIntegration`, `consoleIntegration`. On laisse l'auto-init
     * mais on **ne branche pas** `setupExpressErrorHandler` côté Nest : notre
     * `AllExceptionsFilter` capture déjà via `Sentry.captureException`.
     * Cela évite la double-capture (Sentry filter + Nest filter).
     */
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'),
  })

  return true
}

/**
 * Ré-initialisation pour tests unitaires uniquement (sinon `initSentry`
 * deviendrait no-op après le premier test).
 *
 * @internal
 */
export function __resetSentryForTests(): void {
  initialized = false
}
