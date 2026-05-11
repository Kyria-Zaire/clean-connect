import { SetMetadata } from '@nestjs/common'
import type { Role } from '@prisma/client'

import { ROLES_METADATA_KEY } from '../auth.constants'

/** Liste les rôles autorisés à exécuter un endpoint (consommée par RolesGuard). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_METADATA_KEY, roles)
