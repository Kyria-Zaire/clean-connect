import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'

import { JWT_ACCESS_STRATEGY_NAME } from './auth.constants'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAccessGuard } from './guards/jwt-access.guard'
import { RolesGuard } from './guards/roles.guard'
import { PasswordService } from './services/password.service'
import { TokenService } from './services/token.service'
import { JwtAccessStrategy } from './strategies/jwt-access.strategy'

/**
 * AuthModule — PRD-001 (signup / login / refresh / logout / me).
 *
 * Les guards et le TokenService sont exportés pour être consommables par les
 * modules métier suivants (missions, payments, …). Voir CLAUDE.md §Architecture.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: JWT_ACCESS_STRATEGY_NAME }),
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtAccessStrategy,
    JwtAccessGuard,
    RolesGuard,
  ],
  exports: [TokenService, JwtAccessGuard, RolesGuard],
})
export class AuthModule {}
