/**
 * Enums partagés — **réexportés depuis** `zod-prisma-types` (`./generated/inputTypeSchemas/*`).
 *
 * Source de vérité unique : `apps/api/prisma/schema.prisma`.
 * Imports **fichier par fichier** (pas le barrel `index.ts`) pour éviter de tirer
 * les schémas Prisma JSON auxquels `tsc` strict reproche des incompatibilités Zod.
 */

import { z } from 'zod'

import { MissionServiceTypeSchema } from './generated/inputTypeSchemas/MissionServiceTypeSchema'
import { MissionStatusSchema } from './generated/inputTypeSchemas/MissionStatusSchema'
import { PhotoTypeSchema } from './generated/inputTypeSchemas/PhotoTypeSchema'
import { RoleSchema } from './generated/inputTypeSchemas/RoleSchema'

export { MissionServiceTypeSchema, MissionStatusSchema, PhotoTypeSchema, RoleSchema }

export type Role = z.infer<typeof RoleSchema>
export type MissionStatus = z.infer<typeof MissionStatusSchema>
export type MissionServiceType = z.infer<typeof MissionServiceTypeSchema>
export type PhotoType = z.infer<typeof PhotoTypeSchema>
