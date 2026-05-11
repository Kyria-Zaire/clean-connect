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
