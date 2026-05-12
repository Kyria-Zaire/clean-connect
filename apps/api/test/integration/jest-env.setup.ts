/**
 * Chargé via `setupFiles` dans `jest.integration.config.ts` — AVANT tout import
 * de `AppModule` (qui valide `loadEnv()` au chargement du module).
 *
 * Les jobs CI injectent déjà ces variables ; ce fichier garantit des valeurs
 * déterministes en local (`pnpm --filter @cc/api run test:integration`).
 */

const access = 'ci_jwt_access_secret_min_48_chars_______________________________________'
const refresh = 'ci_refresh_secret_min_48_chars___________________________________________'

process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'recette'
process.env['APP_ENV'] = process.env['APP_ENV'] ?? 'recette'
process.env['JWT_ACCESS_SECRET'] = process.env['JWT_ACCESS_SECRET'] ?? access
process.env['JWT_REFRESH_SECRET'] = process.env['JWT_REFRESH_SECRET'] ?? refresh
process.env['JWT_ACCESS_EXPIRES_IN'] = process.env['JWT_ACCESS_EXPIRES_IN'] ?? '15m'
process.env['JWT_REFRESH_EXPIRES_IN'] = process.env['JWT_REFRESH_EXPIRES_IN'] ?? '30d'

process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ??
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://test:test@localhost:5433/cleanconnect_test'
process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6380'

process.env['CORS_ORIGINS'] = process.env['CORS_ORIGINS'] ?? 'http://localhost:5173'
process.env['STRIPE_SECRET_KEY'] = process.env['STRIPE_SECRET_KEY'] ?? 'sk_test_ci_placeholder'
process.env['STRIPE_WEBHOOK_SECRET'] =
  process.env['STRIPE_WEBHOOK_SECRET'] ?? 'whsec_ci_integration_secret_32chars_min'
process.env['STRIPE_API_VERSION'] = process.env['STRIPE_API_VERSION'] ?? '2025-02-24.acacia'
process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] =
  process.env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] ?? '300'
// PRD-003 Build : la suite payments-webhook.integration override ce flag à 'true'.
// Reste 'false' par défaut pour ne pas activer le webhook dans les autres suites.
process.env['FF_PAYMENTS_ENABLED'] = process.env['FF_PAYMENTS_ENABLED'] ?? 'false'
process.env['APP_VERSION'] = process.env['APP_VERSION'] ?? '0.0.0-test'
process.env['PAYMENT_PLATFORM_FEE_RATE'] = process.env['PAYMENT_PLATFORM_FEE_RATE'] ?? '0.18'

// PRD-003 Ticket 3.3 — feature flag Photos + Cloudinary placeholders.
// La suite photos.integration override `FF_PHOTOS_ENABLED='true'` + override
// le provider Cloudinary (stub). Cette config ne crée donc aucun appel réseau
// même quand le flag est activé.
process.env['FF_PHOTOS_ENABLED'] = process.env['FF_PHOTOS_ENABLED'] ?? 'false'
process.env['CLOUDINARY_URL'] =
  process.env['CLOUDINARY_URL'] ?? 'cloudinary://ci_key:ci_secret@ci_cloud'
process.env['CLOUDINARY_FOLDER_PREFIX'] = process.env['CLOUDINARY_FOLDER_PREFIX'] ?? 'ci'
process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] = process.env['PHOTO_UPLOAD_SESSION_TTL_SECONDS'] ?? '300'
process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] = process.env['PHOTO_SIGNED_URL_TTL_SECONDS'] ?? '300'

process.env['THROTTLE_LIMIT'] = process.env['THROTTLE_LIMIT'] ?? '10000'
process.env['THROTTLE_TTL_SECONDS'] = process.env['THROTTLE_TTL_SECONDS'] ?? '60'
