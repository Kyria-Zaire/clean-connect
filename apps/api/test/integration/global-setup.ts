/**
 * Global setup pour Jest integration tests.
 * Complété par `jest-env.setup.ts` (setupFiles) : secrets JWT, Stripe placeholder, etc.
 * Ici on force surtout `DATABASE_URL` depuis `DATABASE_URL_TEST` si besoin.
 */

// eslint-disable-next-line @typescript-eslint/require-await
export default async function globalSetup(): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(
    '[integration] Assurer que `pnpm db:test:up` tourne avant lancement (port 5433 + 6380).',
  )
  process.env['DATABASE_URL'] =
    process.env['DATABASE_URL_TEST'] ?? 'postgresql://test:test@localhost:5433/cleanconnect_test'
  process.env['REDIS_URL'] = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6380'
}
