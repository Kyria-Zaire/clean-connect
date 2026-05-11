/**
 * AuthService — orchestre signup / login / refresh / logout / me.
 *
 * Garde-fous (cf. PRD-001 §4.3 + ADR-004 + pré-revue sécurité 2026-05-12) :
 *  - Aucun mot de passe ni token (clair ou hash) en log.
 *  - Réponse `INVALID_CREDENTIALS` indistinguable email/password.
 *  - Rotation refresh atomique en `$transaction`.
 *  - Reuse d'un refresh révoqué → révocation cascade des refresh actifs du user.
 *  - Logout idempotent (204 systématique).
 *  - `users.deleted_at` (soft-delete RGPD) bloque login/refresh/me.
 */

import type {
  AuthRefreshResponse,
  AuthSessionResponse,
  AuthUserPublic,
} from '@cc/shared-types'
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import type { Role, User } from '@prisma/client'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'

import { AUTH_ERROR_CODES } from './auth.constants'
import { PasswordService } from './services/password.service'
import { TokenService } from './services/token.service'

interface SignUpInput {
  email: string
  password: string
  role: 'CLIENT' | 'PRESTATAIRE'
  firstName: string
  lastName: string
}

interface LoginInput {
  email: string
  password: string
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async signUp(input: SignUpInput): Promise<AuthSessionResponse> {
    const email = input.email.toLowerCase().trim()

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (existing) {
      this.logger.log({ event: 'auth.signup.conflict' })
      throw new ConflictException({ error: AUTH_ERROR_CODES.EMAIL_ALREADY_USED })
    }

    const passwordHash = await this.passwords.hash(input.password)

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          role: input.role,
          firstName: input.firstName,
          lastName: input.lastName,
        },
      })

      const session = await this.issueSessionFor(user)
      this.logger.log({ event: 'auth.signup.success', userId: user.id, role: user.role })
      return session
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log({ event: 'auth.signup.race_conflict' })
        throw new ConflictException({ error: AUTH_ERROR_CODES.EMAIL_ALREADY_USED })
      }
      throw err
    }
  }

  async login(input: LoginInput): Promise<AuthSessionResponse> {
    const email = input.email.toLowerCase().trim()
    const user = await this.prisma.user.findUnique({ where: { email } })

    if (!user || user.deletedAt) {
      this.logger.log({ event: 'auth.login.failure', reason: 'unknown_or_deleted' })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS })
    }

    const valid = await this.passwords.verify(input.password, user.passwordHash)
    if (!valid) {
      this.logger.log({ event: 'auth.login.failure', reason: 'bad_password', userId: user.id })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS })
    }

    const session = await this.issueSessionFor(user)
    this.logger.log({ event: 'auth.login.success', userId: user.id })
    return session
  }

  async refresh(refreshToken: string): Promise<AuthRefreshResponse> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken)

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    })

    if (!stored) {
      this.logger.warn({ event: 'auth.refresh.failure', reason: 'unknown_hash' })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN })
    }

    const now = new Date()

    if (stored.revokedAt) {
      this.logger.warn({
        event: 'auth.refresh.replay_detected',
        userId: stored.userId,
        refreshTokenId: stored.id,
      })
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: now },
      })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN })
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      this.logger.log({
        event: 'auth.refresh.failure',
        reason: 'expired',
        userId: stored.userId,
      })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN })
    }

    if (stored.user.deletedAt) {
      this.logger.warn({
        event: 'auth.refresh.failure',
        reason: 'user_deleted',
        userId: stored.userId,
      })
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_REFRESH_TOKEN })
    }

    const next = this.tokens.issueRefreshToken()
    const access = await this.tokens.issueAccessToken({
      userId: stored.user.id,
      role: stored.user.role,
    })

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: now },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: stored.user.id,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        },
      }),
    ])

    this.logger.log({ event: 'auth.refresh.rotation', userId: stored.user.id })

    return { accessToken: access.token, refreshToken: next.token }
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken)
    try {
      const result = await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      this.logger.log({ event: 'auth.logout', revoked: result.count })
    } catch (err) {
      // Idempotent — on n'expose jamais l'échec côté client.
      this.logger.warn({ event: 'auth.logout.failure', err: this.scrubError(err) })
    }
  }

  async getMe(userId: string): Promise<AuthUserPublic> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.deletedAt) {
      throw new UnauthorizedException({ error: AUTH_ERROR_CODES.INVALID_CREDENTIALS })
    }
    return this.toPublicUser(user)
  }

  private async issueSessionFor(user: User): Promise<AuthSessionResponse> {
    const access = await this.tokens.issueAccessToken({ userId: user.id, role: user.role })
    const refresh = this.tokens.issueRefreshToken()
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    })
    return {
      user: this.toPublicUser(user),
      accessToken: access.token,
      refreshToken: refresh.token,
    }
  }

  private toPublicUser(user: User): AuthUserPublic {
    return {
      id: user.id,
      email: user.email,
      role: user.role as Role,
      firstName: user.firstName,
      lastName: user.lastName,
      createdAt: user.createdAt.toISOString(),
    }
  }

  private scrubError(err: unknown): { name: string; code?: string } {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return { name: 'PrismaClientKnownRequestError', code: err.code }
    }
    if (err instanceof HttpException) {
      return { name: err.name }
    }
    if (err instanceof Error) {
      return { name: err.name }
    }
    return { name: 'UnknownError' }
  }
}
