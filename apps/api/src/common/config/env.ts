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

    SENTRY_DSN: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),

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
