import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'

import { AuthService } from './auth.service'
import { CurrentUser } from './decorators/current-user.decorator'
import {
  LoginRequestDto,
  LogoutRequestDto,
  MeResponseDto,
  RefreshRequestDto,
  RefreshResponseDto,
  SessionResponseDto,
  SignUpRequestDto,
} from './dto/auth.dto'
import { JwtAccessGuard } from './guards/jwt-access.guard'
import type { AuthenticatedUser } from './types/jwt-payload.type'

/**
 * Endpoints d'authentification (PRD-001).
 *
 * Préfixes globaux Nest : `/api` + version `v1` → routes finales `/api/v1/auth/*`.
 * Rate limiting : surcharge `default` du Throttler par route (cf. PRD §4.3).
 *   - signup  : 5 / 60 s / IP (anti-énumération)
 *   - login   : 10 / 60 s / IP
 *   - refresh : 30 / 60 s / IP
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Créer un compte CLIENT ou PRESTATAIRE' })
  @ApiBody({ type: SignUpRequestDto })
  @ApiResponse({ status: 201, type: SessionResponseDto })
  @ApiResponse({ status: 400, description: 'Validation Zod (incl. WEAK_PASSWORD).' })
  @ApiResponse({ status: 409, description: 'EMAIL_ALREADY_USED' })
  @ApiResponse({ status: 429, description: 'Rate limit dépassé.' })
  async signup(@Body() body: SignUpRequestDto): Promise<SessionResponseDto> {
    return this.auth.signUp({
      email: body.email,
      password: body.password,
      role: body.role,
      firstName: body.firstName,
      lastName: body.lastName,
    })
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Connexion par email + mot de passe' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS (générique).' })
  @ApiResponse({ status: 429, description: 'Rate limit dépassé.' })
  async login(@Body() body: LoginRequestDto): Promise<SessionResponseDto> {
    return this.auth.login({ email: body.email, password: body.password })
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotation du refresh token et nouvel access token',
    description:
      'Invalide l\'ancien refresh (revokedAt = now) et en émet un nouveau dans la même transaction. La réutilisation d\'un refresh révoqué déclenche la révocation cascade de tous les refresh actifs du user.',
  })
  @ApiBody({ type: RefreshRequestDto })
  @ApiOkResponse({ type: RefreshResponseDto })
  @ApiResponse({ status: 401, description: 'INVALID_REFRESH_TOKEN' })
  async refresh(@Body() body: RefreshRequestDto): Promise<RefreshResponseDto> {
    return this.auth.refresh(body.refreshToken)
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Révoque le refresh token transmis (idempotent : toujours 204)' })
  @ApiBody({ type: LogoutRequestDto })
  @ApiResponse({ status: 204, description: 'Toujours 204 (idempotent — pas de leak).' })
  async logout(@Body() body: LogoutRequestDto): Promise<void> {
    await this.auth.logout(body.refreshToken)
  }

  @Get('me')
  @UseGuards(JwtAccessGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Profil de l\'utilisateur connecté (source de vérité front)' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiResponse({ status: 401, description: 'Token absent / invalide / user soft-deleted.' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.auth.getMe(user.id)
  }
}
