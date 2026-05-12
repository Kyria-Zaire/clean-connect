/**
 * PRD-003 Ticket 3.5 — Observabilité admin : transfers Connect.
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Role } from '@prisma/client'

import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type'

import { OutboundTransferService } from './transfers/outbound-transfer.service'
import { TransfersRepository } from './transfers/transfers.repository'

@ApiTags('admin-transfers')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'admin/transfers', version: '1' })
export class AdminTransfersController {
  constructor(
    private readonly transfers: TransfersRepository,
    private readonly outbound: OutboundTransferService,
  ) {}

  @Get()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister les transfers (ADMIN — observabilité Ticket 3.5)' })
  async list(
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.min(Number(limitRaw ?? '50') || 50, 100)
    const allowed = ['PENDING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'REVERSED'] as const
    const st = status && (allowed as readonly string[]).includes(status) ? (status as (typeof allowed)[number]) : undefined
    const rows = await this.transfers.listForAdmin({
      limit,
      cursor,
      status: st,
    })
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null
    return { items: rows, nextCursor }
  }

  @Post(':id/retry')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Relancer un transfer FAILED/RETRY_SCHEDULED (ADMIN — Ticket 3.5)' })
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ accepted: true }> {
    try {
      await this.outbound.retryFromAdmin(id, user.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      if (msg === 'transfer_not_found') throw new BadRequestException({ error: 'TRANSFER_NOT_FOUND' })
      if (msg === 'transfer_not_retryable_state') {
        throw new BadRequestException({ error: 'TRANSFER_RETRY_NOT_ALLOWED' })
      }
      if (msg === 'prestataire_missing') throw new BadRequestException({ error: 'TRANSFER_PROVIDER_NOT_READY' })
      throw e
    }
    return { accepted: true }
  }
}
