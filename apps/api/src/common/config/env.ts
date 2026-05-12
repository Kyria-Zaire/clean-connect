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

    CLOUDINARY_URL: z.string().url().optional(),
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
