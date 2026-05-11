import { type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard } from '@nestjs/passport'

import { IS_PUBLIC_METADATA_KEY, JWT_ACCESS_STRATEGY_NAME } from '../auth.constants'

/**
 * Garde de routes protégées par access JWT.
 * Bypass possible via le décorateur `@Public()` (utilisé sur signup/login/refresh/logout).
 */
@Injectable()
export class JwtAccessGuard extends AuthGuard(JWT_ACCESS_STRATEGY_NAME) {
  constructor(private readonly reflector: Reflector) {
    super()
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true
    return super.canActivate(context)
  }
}
