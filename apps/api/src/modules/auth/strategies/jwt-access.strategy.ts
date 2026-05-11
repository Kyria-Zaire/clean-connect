import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'

import { loadEnv } from '../../../common/config/env'
import { JWT_ACCESS_STRATEGY_NAME } from '../auth.constants'
import type { AuthenticatedUser, JwtAccessPayload } from '../types/jwt-payload.type'

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, JWT_ACCESS_STRATEGY_NAME) {
  constructor() {
    const env = loadEnv()
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.JWT_ACCESS_SECRET,
    })
  }

  /**
   * Retourne l'objet attaché à `req.user`. On reste minimal : la source de
   * vérité profil utilisateur reste `/auth/me`.
   */
  validate(payload: JwtAccessPayload): AuthenticatedUser {
    if (!payload.sub || !payload.role || !payload.jti) {
      throw new UnauthorizedException()
    }
    return { id: payload.sub, role: payload.role, jti: payload.jti }
  }
}
