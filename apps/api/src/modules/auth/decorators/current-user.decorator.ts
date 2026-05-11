import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

import type { AuthenticatedUser } from '../types/jwt-payload.type'

/** Récupère l'utilisateur authentifié injecté par JwtAccessStrategy. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>()
    if (!req.user) {
      throw new Error(
        'CurrentUser appelé sans JwtAccessGuard — l\'utilisateur n\'est pas authentifié.',
      )
    }
    return req.user
  },
)
