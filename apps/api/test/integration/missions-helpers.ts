/**
 * Helpers — tests d'intégration Missions (PRD-002 Build).
 *
 * Conventions :
 *  - Tous les emails de test contiennent `@cc-test.fr` pour permettre un cleanup
 *    ciblé (cf. afterAll des suites integration).
 *  - Aucune adresse complète loggée — on lit uniquement city/zipCode (zone publique).
 */

import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '../../src/common/prisma/prisma.service'

export const MISSIONS_BASE = '/api/v1/missions'
export const ADMIN_MISSIONS_BASE = '/api/v1/admin/missions'

export const STRONG_PASSWORD = 'Sup3rSecret_passw0rd_2026!'

export const randomMissionEmail = (prefix: string): string =>
  `mit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@cc-test.fr`

interface CreateUserOptions {
  role: 'CLIENT' | 'PRESTATAIRE' | 'ADMIN'
  /** Coordonnées GPS de la base (uniquement utile pour PRESTATAIRE matching). */
  base?: { city: string; zipCode: string; street: string; lat: number; lng: number }
  serviceRadiusKm?: number
  suspended?: boolean
  unverified?: boolean
}

/**
 * Crée un utilisateur directement via Prisma (bypass HTTP, indépendant des tests auth).
 * - Le password n'est jamais utilisé (pas de login dans les tests missions, on
 *   forge le JWT via TokenService).
 */
export async function createTestUser(
  prisma: PrismaService,
  opts: CreateUserOptions,
): Promise<{ id: string; email: string }> {
  const email = randomMissionEmail(opts.role.toLowerCase())
  let addressId: string | null = null
  if (opts.base) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "addresses" ("id", "street", "city", "zip_code", "country", "location", "created_at", "updated_at")
      VALUES (
        gen_random_uuid(),
        ${opts.base.street},
        ${opts.base.city},
        ${opts.base.zipCode},
        'FR',
        ST_SetSRID(ST_MakePoint(${opts.base.lng}::double precision, ${opts.base.lat}::double precision), 4326)::geography,
        NOW(),
        NOW()
      )
      RETURNING "id"::text
    `
    addressId = rows[0]?.id ?? null
  }
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: '$2b$10$placeholder.placeholder.placeholder.placeholder.placeholder',
      firstName: 'IT',
      lastName: 'User',
      role: opts.role,
      addressId,
      serviceRadiusKm: opts.serviceRadiusKm ?? 15,
      suspendedAt: opts.suspended ? new Date() : null,
      verifiedAt: opts.unverified ? null : new Date(),
    },
  })
  return { id: user.id, email: user.email }
}

/** Vide les tables touchées par les tests missions (limité aux emails @cc-test.fr). */
export async function cleanupMissions(prisma: PrismaService): Promise<void> {
  // Récupère IDs des users de test
  const users = await prisma.user.findMany({
    where: { email: { contains: '@cc-test.fr' } },
    select: { id: true, addressId: true },
  })
  if (users.length === 0) return

  const userIds = users.map((u) => u.id)
  const userAddressIds = users.map((u) => u.addressId).filter((id): id is string => id !== null)

  // missions des CLIENTs
  const missions = await prisma.mission.findMany({
    where: { clientId: { in: userIds } },
    select: { id: true, addressId: true },
  })
  const missionIds = missions.map((m) => m.id)
  const missionAddressIds = missions.map((m) => m.addressId)

  if (missionIds.length > 0) {
    await prisma.missionEvent.deleteMany({ where: { missionId: { in: missionIds } } })
    await prisma.missionProposal.deleteMany({ where: { missionId: { in: missionIds } } })
    await prisma.mission.deleteMany({ where: { id: { in: missionIds } } })
  }
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })

  const allAddressIds = Array.from(new Set([...userAddressIds, ...missionAddressIds]))
  if (allAddressIds.length > 0) {
    await prisma.address.deleteMany({ where: { id: { in: allAddressIds } } })
  }
}

/** Forge un access JWT signé via TokenService (évite signup HTTP dans les tests missions). */
export async function forgeAccessToken(
  app: INestApplication,
  user: { id: string; role: 'CLIENT' | 'PRESTATAIRE' | 'ADMIN' },
): Promise<string> {
  const tokenServiceModule = await import('../../src/modules/auth/services/token.service')
  const TokenService = tokenServiceModule.TokenService
  const svc = app.get(TokenService)
  const issued = await svc.issueAccessToken({ userId: user.id, role: user.role })
  return issued.token
}
