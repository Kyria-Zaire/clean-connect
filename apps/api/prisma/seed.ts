/**
 * Seed Clean Connect — données de dev minimales.
 * Exécution : `pnpm --filter @cc/api run db:seed`
 *
 * Politique : seed = données neutres et anonymes uniquement (pas de PII réelle).
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // eslint-disable-next-line no-console
  console.error('[seed] Sprint 0.2 — seed initial vide (à enrichir au fil des PRDs).')
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
