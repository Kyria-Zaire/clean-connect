/**
 * PRD-003 Ticket 3.5 — Observabilité admin : refunds + DLQ replay Stripe.
 */

import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Role } from '@prisma/client'

import { Roles } from '../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard'
import { RolesGuard } from '../auth/guards/roles.guard'

import { RefundsRepository } from './refunds/refunds.repository'
import { PaymentsWebhookService } from './webhooks/payments-webhook.service'

@ApiTags('admin-refunds-dlq')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminRefundsAndDlqController {
  constructor(
    private readonly refunds: RefundsRepository,
    private readonly webhook: PaymentsWebhookService,
  ) {}

  @Get('refunds')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister les refunds (ADMIN — Ticket 3.5)' })
  async listRefunds(
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.min(Number(limitRaw ?? '50') || 50, 100)
    const allowed = ['PENDING', 'REFUNDED', 'FAILED'] as const
    const st = status && (allowed as readonly string[]).includes(status) ? (status as (typeof allowed)[number]) : undefined
    const rows = await this.refunds.listForAdmin({ limit, cursor, status: st })
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null
    return { items: rows, nextCursor }
  }

  @Get('webhooks/stripe-dead-letters')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister la DLQ webhooks Stripe (ADMIN — Ticket 3.5)' })
  async listDlq(
    @Query('limit') limitRaw?: string,
    @Query('resolved') resolved?: string,
  ): Promise<{ items: unknown[] }> {
    const limit = Math.min(Number(limitRaw ?? '50') || 50, 100)
    const items = await this.webhook.listStripeDeadLetters({ limit, resolved: resolved === 'true' })
    return { items }
  }

  @Post('webhooks/stripe-dead-letters/:id/replay')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Replay admin-only d’un événement Stripe DLQ (Ticket 3.5)' })
  async replayDlq(@Param('id', ParseUUIDPipe) id: string): Promise<{ accepted: true }> {
    await this.webhook.replayStripeDeadLetter(id)
    return { accepted: true }
  }
}
