/**
 * PRD-003 Ticket 3.2 — Controller ADMIN pour `Payments`.
 *
 * Endpoint :
 *  - `GET /v1/admin/payments` → listing paginé avec filtres (status, clientId,
 *    missionId). `AdminPaymentView` — montants complets, commission visible.
 *
 * Rule securite : aucun `clientSecret` ni token Stripe brut exposé ici
 * (cf. `paymentInternalSchema` vs `adminPaymentViewSchema`).
 */

import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards, Body } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Role } from '@prisma/client'

import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type'

import { AdminPaymentListQueryDto, AdminPaymentListResponseDto } from './dto/payments.dto'
import { PaymentsService } from './payments.service'
import { RefundsService } from './refunds/refunds.service'

@ApiTags('admin-payments')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'admin/payments', version: '1' })
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Get()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister les paiements (ADMIN — admin support / audit)' })
  @ApiOkResponse({ type: AdminPaymentListResponseDto })
  @ApiResponse({ status: 503, description: 'PAYMENTS_DISABLED — feature flag off.' })
  async list(@Query() query: AdminPaymentListQueryDto): Promise<AdminPaymentListResponseDto> {
    return this.payments.listForAdmin(query)
  }

  @Post(':paymentId/refund')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Remboursement intégral (ADMIN uniquement — Ticket 3.5). Interdit si transfer `SENT`.',
  })
  async refund(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { amountCents?: number },
  ): Promise<{ accepted: true; refundId: string; stripeRefundId: string | null }> {
    return this.refunds.adminCreateFullRefund({
      paymentId,
      adminUserId: user.id,
      amountCents: body.amountCents,
    })
  }
}
