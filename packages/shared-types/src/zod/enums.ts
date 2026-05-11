/**
 * Enums partagés — DOIVENT rester alignés avec `apps/api/prisma/schema.prisma`.
 *
 * À terme, ces enums seront générés automatiquement via `zod-prisma-types`
 * (cf. générateur configuré dans schema.prisma). Tant que ce générateur n'est
 * pas câblé, on les déclare ici à la main comme source de vérité partagée.
 */

import { z } from 'zod'

export const RoleSchema = z.enum(['CLIENT', 'PRESTATAIRE', 'ADMIN'])
export type Role = z.infer<typeof RoleSchema>

export const MissionStatusSchema = z.enum([
  'DRAFT',
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
])
export type MissionStatus = z.infer<typeof MissionStatusSchema>

export const PhotoTypeSchema = z.enum(['BEFORE', 'AFTER'])
export type PhotoType = z.infer<typeof PhotoTypeSchema>
