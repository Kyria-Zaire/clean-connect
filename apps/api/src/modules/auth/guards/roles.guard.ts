import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Role } from '@prisma/client'
import type { Request } from 'express'

import { ROLES_METADATA_KEY } from '../auth.constants'
import type { AuthenticatedUser } from '../types/jwt-payload.type'

/**
 * Vérifie que `request.user.role` est inclus dans les rôles requis
 * (@Roles(Role.X, Role.Y)). À utiliser APRÈS JwtAccessGuard.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>()
    const user = req.user
    if (!user) {
      throw new ForbiddenException()
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException()
    }
    return true
  }
}
