/**
 * Validation stricte des variables d'environnement au démarrage.
 * Crash immédiat si un secret obligatoire manque (rule ingenieur).
 */

import { z } from 'zod'

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'recette', 'preprod', 'production']).default('development'),
    APP_ENV: z.enum(['development', 'recette', 'preprod', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    REDIS_URL: z.string().url().startsWith('redis://'),

    JWT_ACCESS_SECRET: z.string().min(48, 'JWT_ACCESS_SECRET doit faire au moins 48 caractères.'),
    JWT_REFRESH_SECRET: z.string().min(48, 'JWT_REFRESH_SECRET doit faire au moins 48 caractères.'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

    CORS_ORIGINS: z
      .string()
      .min(1)
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

    STRIPE_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, 'Préfixe sk_test_ ou sk_live_ requis.'),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
    /**
     * Version API Stripe pinnée (ADR-011 / rule stripe). Format `YYYY-MM-DD.<codename>`.
     * Le SDK est instancié avec cette version exacte ; le dashboard webhook DOIT
     * pointer la même version sur test + live (audit Verify V8).
     * Bump = nouvel ADR + tests régression. Aucun fallback `latest` autorisé.
     */
    STRIPE_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/u, 'Format YYYY-MM-DD.codename requis (ADR-011).')
      .default('2025-02-24.acacia'),
    /**
     * Tolérance HMAC `stripe.webhooks.constructEvent` (en secondes).
     * Par défaut 300s = recommandation Stripe. Réduire ne casse pas la sécurité
     * (HMAC reste validé) — c'est juste la fenêtre anti-replay basée sur `timestamp` Stripe.
     */
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

    /**
     * Feature flag — gate complet du module Payments (controller webhook + processors).
     * Décision CTO Build : `false` par défaut tant que l'observabilité Stripe n'est pas
     * branchée en recette/preprod. Crash boot si `true` en production sans webhook secret
     * réel (cf. `superRefine`).
     */
    FF_PAYMENTS_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * Version applicative — utilisée par le SDK Stripe pour `appInfo` (rule stripe).
     * Doit refléter la version publiée (CI peut injecter le SHA git court).
     */
    APP_VERSION: z.string().min(1).max(40).default('0.1.0-dev'),

    /**
     * PRD-003 Ticket 3.2 — taux de commission plateforme (snapshot lock-in à la
     * création du PaymentIntent, ADR-008 §4). `0.18` = 18 % du montant TTC.
     * - **Snapshot immutable** : même si on change la valeur côté env, les
     *   Payments existants conservent la commission calculée à leur création.
     * - Bornes : `[0, 0.5]` — toute valeur > 50 % est probablement une faute
     *   de frappe (crash boot).
     * - Le calcul exact HT/TTC sera réaffiné en Ticket 3.4 (transfer Connect).
     *   En 3.2 on snapshote pour fixer les contrats DB ; aucun Transfer n'est
     *   encore émis.
     */
    PAYMENT_PLATFORM_FEE_RATE: z.coerce.number().min(0).max(0.5).default(0.18),

    /**
     * Cloudinary credentials (PRD-003 Ticket 3.3 — ADR-009).
     * Format : `cloudinary://<api_key>:<api_secret>@<cloud_name>`.
     * Parsé au boot par `CloudinaryClientFactory` ; secret jamais loggé (Pino redactor).
     * Requis quand `FF_PHOTOS_ENABLED=true` (cf. `superRefine` plus bas).
     */
    CLOUDINARY_URL: z
      .string()
      .regex(
        /^cloudinary:\/\/[^:]+:[^@]+@[a-zA-Z0-9_-]+$/u,
        'Format attendu : cloudinary://<api_key>:<api_secret>@<cloud_name>',
      )
      .optional(),
    /**
     * Préfixe de dossier Cloudinary appliqué côté serveur :
     *   `<prefix>/missions/<missionId>/<phase>/<captureClientUuid>/<variant>`.
     * Permet d'isoler dev / recette / preprod / prod sur le même cloud Cloudinary.
     */
    CLOUDINARY_FOLDER_PREFIX: z.string().min(1).max(64).default('dev'),
    /**
     * Feature flag — gate complet du module Photos (controllers + Cloudinary client).
     * Reste `false` par défaut tant que Cloudinary n'est pas branché en recette/preprod.
     * Crash boot si `true` sans `CLOUDINARY_URL` valide (cf. `superRefine`).
     */
    FF_PHOTOS_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * Durée de validité d'une `PhotoUploadSession` (secondes). Défaut 5 min (ADR-009).
     * Au-delà → 410 `UPLOAD_SESSION_EXPIRED` côté `POST /photos/confirm`.
     */
    PHOTO_UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    /**
     * Durée de validité d'une signed URL Cloudinary en lecture (secondes).
     * Défaut 5 min (ADR-009). Utilisé Ticket 3.4 — `GET /photos/:id/signed-url`.
     */
    PHOTO_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_SERVER_KEY: z.string().optional(),

    MAIL_PROVIDER: z.enum(['sendgrid', 'postmark']).optional(),
    MAIL_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().email().optional(),

    /**
     * PRD-004 Ticket 4.1 (A1) — observabilité Sentry.
     *
     * `SENTRY_DSN` est **optionnel** : laissé vide → SDK initialisé en no-op
     * (utile en dev local + tests). En recette/preprod/prod le DSN est injecté
     * par la CI via secret. Aucun fallback `latest` ou cluster public.
     *
     * `SENTRY_ENVIRONMENT` permet de tagger les events. Par défaut on retombe
     * sur `APP_ENV` côté `sentry.config.ts` si absent.
     *
     * `SENTRY_RELEASE` est utilisé pour le release tracking ; format conseillé
     * `clean-connect@<APP_VERSION>+<git_sha>` (ADR-014 §2.4). Défaut applicatif
     * = `clean-connect@${APP_VERSION}`.
     *
     * `SENTRY_TRACES_SAMPLE_RATE` borné `[0, 1]` (ADR-014 §2.5). Recettes
     * recommandées : `1.0` dev, `0.5` recette, `0.1` prod. Override 100 %
     * sur les routes finance/webhook géré côté `sentry.config.ts` via
     * `tracesSampler` callback (pas via la variable d'env).
     */
    SENTRY_DSN: z
      .string()
      .url('SENTRY_DSN doit être une URL valide (https://<key>@sentry.io/<project>) ou vide.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    SENTRY_ENVIRONMENT: z.string().min(1).max(32).optional(),
    SENTRY_RELEASE: z.string().min(1).max(128).optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

    /**
     * PRD-004 Ticket 4.1 (A3) — métriques Prometheus.
     *
     * `METRICS_ENABLED` : feature flag global de l'endpoint `/api/internal/metrics`.
     * En prod, valeur `true` recommandée (sinon Prometheus ne scrape rien).
     * En tests intégration : `false` par défaut pour éviter pollution registry
     * entre suites parallèles.
     *
     * `METRICS_BEARER_TOKEN` : token statique opaque (≥ 32 chars, hex/base64)
     * partagé avec l'agent Prometheus. Vérifié en `timingSafeEqual` côté guard.
     * Crash boot si `METRICS_ENABLED=true` en production sans token (cf.
     * `superRefine` plus bas).
     */
    METRICS_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .default('true')
      .transform((v) => v !== 'false'),
    METRICS_BEARER_TOKEN: z.string().min(32).max(256).optional(),

    THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),

    /**
     * Délai après publication d'une mission au-delà duquel elle passe en EXPIRED
     * si aucun prestataire n'a accepté. Décision Discover Q5 : 15 min.
     * Configurable pour tests / pré-prod (cf. ADR-005).
     */
    MISSION_LISTING_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000)
      .default(15 * 60 * 1_000),

    /**
     * Plafond serveur pour les requêtes radius PostGIS (matching).
     * Contrainte CTO Build §3 : aucune requête de matching sans limite.
     */
    MATCHING_MAX_PROVIDERS: z.coerce.number().int().min(1).max(500).default(50),

    /**
     * Endpoint BAN (Base Adresse Nationale) — provider principal géocodage
     * (Discover Q3 + ADR-006). Override possible en tests pour mocker.
     */
    BAN_BASE_URL: z
      .string()
      .url()
      .default('https://api-adresse.data.gouv.fr'),
    BAN_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(5_000),

    /**
     * Bypass total du Throttler — réservé aux tests d'intégration (cf.
     * `ConditionalThrottlerGuard`). CRASH BOOT si activé en production
     * (`superRefine` plus bas). Jamais lu dans le code métier hors guard.
     */
    DISABLE_THROTTLE: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * PRD-004 Ticket 4.5 — Feature flag global du monitoring financier.
     * Quand `false` (défaut MVP) : les @Cron schedulers se court-circuitent en
     * début de tick (audit log uniquement), aucun appel Stripe API. Active
     * quand recette + dashboards Grafana finance prêts.
     */
    FF_FINANCE_MONITORING_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * PRD-004 Ticket 4.5 §4.15.3 AC-4.5.3.3 — seuil détection anomalie payout.
     * `J-1.amountCents > FINANCE_PAYOUT_ANOMALY_FACTOR × avgLast30dCents` ⇒ flag.
     * Bornes `[1.5, 5.0]` pour éviter faux positifs (< 1.5) ou désactivation
     * implicite (> 5.0). Default 2.0 (CTO Design OQ).
     */
    FINANCE_PAYOUT_ANOMALY_FACTOR: z.coerce.number().min(1.5).max(5.0).default(2.0),

    /**
     * PRD-004 Ticket 4.5 — Rate-limit endpoint `POST /v1/admin/finance/runs/manual`
     * (OQ-13). 1 run / heure / admin. Override pour tests.
     */
    FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(60).default(1),

    /**
     * PRD-004 §4.15.17 `FIN-RECONCILE-PAGING` — taille max d'une page de Payments
     * scannés par run `RECONCILE` (borne Stripe + DB). Default 600 (Design
     * itération 2). Tests intégration peuvent descendre à 2–10.
     */
    FINANCE_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(600).default(600),

    /**
     * PRD-004 §4.15.17 `FIN-RECONCILE-PAGING` — nombre max d'itérations cursor
     * (`batchSize` × `maxPages` = plafond absolu de Payments par run). Default
     * 100 ⇒ 60 000 rows worst-case (largement > fenêtre 7j attendue MVP).
     */
    FINANCE_RECONCILE_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(100),

    /**
     * PRD-004 §4.15.17 `FIN-DAILY-EMAIL` — Resend REST (`api.resend.com/emails`).
     * Tous optionnels : absence totale ⇒ email daily report désactivé (silent skip).
     */
    RESEND_API_KEY: z
      .string()
      .min(8)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    FINANCE_DAILY_REPORT_EMAIL_TO: z
      .string()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    RESEND_FROM_EMAIL: z
      .string()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),

    /**
     * PRD-004 Ticket 4.5 — Rétention `FinanceMismatch` RESOLVED/IGNORED (jours).
     * OQ-12. Default 90 j. `0` ⇒ purge désactivée (debug only).
     */
    FINANCE_MISMATCH_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(90),

    /**
     * PRD-004 Ticket 4.5 — Rétention `FinanceDailyReport` (jours). OQ-12.
     * Default 5 ans = 1825 j (pratique comptable interne).
     */
    FINANCE_DAILY_REPORT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(1_825),

    /**
     * PRD-004 Ticket 4.5 — Rétention `FinanceAlert` (jours). Default 30 j.
     */
    FINANCE_ALERT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
  })
  .superRefine((data, ctx) => {
    // Garde-fou Stripe ↔ environnement (cf. rule securite + stripe)
    const isProdEnv = data.APP_ENV === 'production'
    const isLiveKey = data.STRIPE_SECRET_KEY.startsWith('sk_live_')
    if (isProdEnv !== isLiveKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Incohérence Stripe / environnement : sk_live_* requis en production, sk_test_* ailleurs.',
        path: ['STRIPE_SECRET_KEY'],
      })
    }
    // Garde-fou PRD-001 / ADR-004 : les deux secrets JWT NE DOIVENT JAMAIS être identiques.
    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent être différents (ADR-004).',
        path: ['JWT_REFRESH_SECRET'],
      })
    }
    // Garde-fou sécurité : impossible de désactiver le throttler en prod.
    if (data.DISABLE_THROTTLE && data.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DISABLE_THROTTLE=true interdit en NODE_ENV=production.',
        path: ['DISABLE_THROTTLE'],
      })
    }
    // Garde-fou PRD-003 Build : si Payments activés, secret webhook doit être réel
    // (pas un placeholder `whsec_ci_*`). On bloque les flags incohérents au boot.
    if (data.FF_PAYMENTS_ENABLED && data.NODE_ENV === 'production') {
      if (data.STRIPE_WEBHOOK_SECRET.startsWith('whsec_ci_') ||
          data.STRIPE_WEBHOOK_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'STRIPE_WEBHOOK_SECRET placeholder/court interdit avec FF_PAYMENTS_ENABLED=true en production (PRD-003).',
          path: ['STRIPE_WEBHOOK_SECRET'],
        })
      }
    }
    // Garde-fou PRD-004 Ticket 4.1 (A3) : en production, l'endpoint /metrics
    // doit obligatoirement être protégé par un token. Crash boot si le flag
    // est activé sans token (sinon scraper anonyme = exposition labels infra).
    if (data.METRICS_ENABLED && data.NODE_ENV === 'production' && !data.METRICS_BEARER_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'METRICS_BEARER_TOKEN obligatoire en production quand METRICS_ENABLED=true (PRD-004 A3).',
        path: ['METRICS_BEARER_TOKEN'],
      })
    }
    // Garde-fou PRD-003 Ticket 3.3 : si Photos activées, l'URL Cloudinary doit
    // être présente (sinon le module crash au démarrage faute de credentials).
    if (data.FF_PHOTOS_ENABLED && !data.CLOUDINARY_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'CLOUDINARY_URL est obligatoire quand FF_PHOTOS_ENABLED=true (PRD-003 Ticket 3.3).',
        path: ['CLOUDINARY_URL'],
      })
    }
  })

export type Env = z.infer<typeof envSchema>

let cachedEnv: Env | null = null

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('[env] Variables d\'environnement invalides :', parsed.error.flatten().fieldErrors)
    throw new Error('Environnement invalide — démarrage interrompu.')
  }
  cachedEnv = parsed.data
  return cachedEnv
}

/**
 * @internal — usage exclusif des tests unitaires/intégration pour forcer une
 * re-lecture de `process.env`. JAMAIS appeler en runtime.
 */
export function __resetEnvCacheForTests(): void {
  cachedEnv = null
}
