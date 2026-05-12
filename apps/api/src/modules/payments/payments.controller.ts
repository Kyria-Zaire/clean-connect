/**
 * PRD-003 Ticket 3.2 — Controller CLIENT pour `Payments`.
 *
 * Endpoints :
 *  - `POST /v1/payments/intent`   → création PaymentIntent (capture manuelle).
 *  - `GET  /v1/payments/mine`     → listing paginé des paiements du CLIENT.
 *
 * Contrainte CTO Build §7 — aucune logique métier ici (HTTP I/O uniquement).
 * Toute la mécanique (idempotence, transitions, snapshots) vit dans
 * `PaymentsService`. Le `clientSecret` retourné par `POST /v1/payments/intent`
 * n'est JAMAIS persisté côté DB ni reloggable côté API (rule securite + Pino).
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Role } from '@prisma/client'

import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type'

import {
  ClientPaymentListQueryDto,
  ClientPaymentListResponseDto,
  CreatePaymentIntentBodyDto,
  CreatePaymentIntentResponseDto,
} from './dto/payments.dto'
import { PaymentsService } from './payments.service'

@ApiTags('payments')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('intent')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un PaymentIntent Stripe pour une mission (CLIENT)' })
  @ApiResponse({ status: 201, type: CreatePaymentIntentResponseDto })
  @ApiResponse({ status: 400, description: 'PAYMENT_MISSING_IDEMPOTENCY_KEY' })
  @ApiResponse({ status: 403, description: 'MISSION_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'PAYMENT_INVALID_STATE / PAYMENT_IDEMPOTENCY_CONFLICT' })
  @ApiResponse({ status: 422, description: 'PAYMENT_AMOUNT_REQUIRED / PAYMENT_STRIPE_ERROR' })
  @ApiResponse({ status: 503, description: 'PAYMENTS_DISABLED — feature flag off.' })
  async createIntent(
    @Body() body: CreatePaymentIntentBodyDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreatePaymentIntentResponseDto> {
    return this.payments.createIntent(
      body.missionId,
      { userId: user.id, role: 'CLIENT' },
      idempotencyKey,
    )
  }

  @Get('mine')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister mes paiements (CLIENT)' })
  @ApiOkResponse({ type: ClientPaymentListResponseDto })
  @ApiResponse({ status: 503, description: 'PAYMENTS_DISABLED — feature flag off.' })
  async listMine(
    @Query() query: ClientPaymentListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ClientPaymentListResponseDto> {
    return this.payments.listForClient({ userId: user.id, role: 'CLIENT' }, query)
  }
}
