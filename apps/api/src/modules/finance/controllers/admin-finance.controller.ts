/**
 * PRD-004 Ticket 4.5 — Admin finance endpoints (`/v1/admin/finance/*`).
 *
 * RBAC : `JwtAccessGuard` + `RolesGuard` + `@Roles(Role.ADMIN)` sur toutes les routes.
 * Rate-limit manual run : OQ-13 — `FINANCE_MANUAL_RUN_RATE_LIMIT_PER_HOUR` (env).
 *
 * Audit `MissionEvent` : sur transitions mismatch + manual run — payload sanitizé
 * (`sanitizeForFinanceSnapshot`) + **aucune PII**.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { FinanceMismatchStatus, Prisma, Role } from '@prisma/client'
import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { deepSanitize } from '../../../common/security/sanitize'
import { CurrentUser } from '../../auth/decorators/current-user.decorator'
import { Roles } from '../../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../../auth/guards/jwt-access.guard'
import { RolesGuard } from '../../auth/guards/roles.guard'
import type { AuthenticatedUser } from '../../auth/types/jwt-payload.type'
import { FINANCE_AUDIT_EVENT_TYPES, type FinanceInvariantCode } from '../finance.constants'
import { FinanceRepository } from '../finance.repository'
import { FinanceMismatchService } from '../services/finance-mismatch.service'
import { FinanceReconcileService } from '../services/finance-reconcile.service'

/**
 * Build itération 2 — `status` accepte désormais `ACKNOWLEDGED` (lifecycle ACK).
 * `notes` requis ≥ 16 chars pour `RESOLVED|IGNORED` (validation côté service —
 * Zod laisse passer l'absence ici car l'admin peut ACK sans note encore).
 */
const financeMismatchTransitionBodySchema = z.object({
  status: z.nativeEnum(FinanceMismatchStatus),
  notes: z.string().max(1024).optional(),
})

class FinanceMismatchTransitionBodyDto extends createZodDto(financeMismatchTransitionBodySchema) {}

const financeListMismatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  status: z.nativeEnum(FinanceMismatchStatus).optional(),
  mismatchCode: z
    .string()
    .regex(/^FIN-[IJ]-\d{3}$/i, 'mismatchCode must match /^FIN-[IJ]-\\d{3}$/')
    .optional(),
})

@ApiTags('admin-finance')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'admin/finance', version: '1' })
export class AdminFinanceController {
  constructor(
    private readonly repo: FinanceRepository,
    private readonly mismatches: FinanceMismatchService,
    private readonly reconcile: FinanceReconcileService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('mismatches')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lister les mismatches finance (ADMIN — PRD-004 §4.15)' })
  async listMismatches(
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
    @Query('status') statusRaw?: string,
    @Query('mismatchCode') mismatchCodeRaw?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const parsed = financeListMismatchesQuerySchema.safeParse({
      limit: limitRaw,
      cursor,
      status: statusRaw,
      mismatchCode: mismatchCodeRaw,
    })
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'FINANCE_LIST_MISMATCHES_INVALID_QUERY',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const q = parsed.data
    return this.repo.listMismatches({
      limit: q.limit,
      cursor: q.cursor ?? null,
      status: q.status,
      mismatchCode: q.mismatchCode as FinanceInvariantCode | undefined,
    })
  }

  @Get('mismatches/:id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Détail mismatch finance (ADMIN)' })
  async getMismatch(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const row = await this.repo.getMismatch(id)
    if (!row) throw new NotFoundException({ error: 'FINANCE_MISMATCH_NOT_FOUND' })
    return row
  }

  @Patch('mismatches/:id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mettre à jour le statut d’un mismatch finance (ADMIN)' })
  async transitionMismatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FinanceMismatchTransitionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    const transition = await this.mismatches.transition({
      id,
      status: body.status,
      actorUserId: user.id,
      notes: body.notes ?? null,
    })

    const mismatch = await this.prisma.financeMismatch.findUnique({
      where: { id },
      select: {
        resourceKind: true,
        resourceId: true,
        type: true,
        severity: true,
        mismatchCode: true,
      },
    })
    if (mismatch) {
      await this.writeMissionAuditEvent({
        actorUserId: user.id,
        resourceKind: mismatch.resourceKind,
        resourceId: mismatch.resourceId,
        type: AUDIT_EVENT_FOR_STATUS[body.status],
        payload: deepSanitize({
          mismatchId: id,
          mismatchCode: mismatch.mismatchCode,
          mismatchType: mismatch.type,
          severity: mismatch.severity,
          fromStatus: transition.from,
          toStatus: transition.to,
        }) as Prisma.InputJsonValue,
      })
    }

    return { ok: true }
  }

  @Post('runs/manual')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Déclencher un run finance manuel (ADMIN — OQ-13)' })
  async manualRun(@CurrentUser() user: AuthenticatedUser): Promise<{ accepted: true; runId: string }> {
    /*
     * `FIN-MANUAL-RATELIMIT` (PRD-004 §4.15.17) — la garde rate-limit OQ-13
     * (`429`) est désormais **atomique** côté service :
     *   `reconcile.runManual` → `repo.tryReserveManualRun` (advisory lock
     *   user-scoped + `count + INSERT` même transaction Postgres).
     * Le `409 FINANCE_RECONCILE_BUSY` reste géré par le même service (lock
     * global reconcile). On laisse remonter telles quelles via NestJS.
     */
    const { runId } = await this.reconcile.runManual(user.id)

    await this.writeMissionAuditEvent({
      actorUserId: user.id,
      resourceKind: 'INVARIANT',
      resourceId: runId,
      type: FINANCE_AUDIT_EVENT_TYPES.manualRunTriggered,
      payload: deepSanitize({ runId, kind: 'RECONCILE' }) as Prisma.InputJsonValue,
    })

    return { accepted: true, runId }
  }

  @Get('daily-report/:date')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lire un daily report finance par date (YYYY-MM-DD)' })
  async getDailyReport(@Param('date') date: string): Promise<unknown> {
    const d = parseYyyyMmDdUtc(date)
    if (!d) throw new BadRequestException({ error: 'FINANCE_INVALID_DATE' })
    const row = await this.repo.getDailyReportByDate(d)
    if (!row) throw new NotFoundException({ error: 'FINANCE_DAILY_REPORT_NOT_FOUND' })
    return row
  }

  private async writeMissionAuditEvent(args: {
    actorUserId: string
    resourceKind: 'PAYMENT' | 'TRANSFER' | 'REFUND' | 'INVARIANT'
    resourceId: string
    type: string
    payload: Prisma.InputJsonValue
  }): Promise<void> {
    const missionId = await this.resolveMissionIdForResource({
      resourceKind: args.resourceKind,
      resourceId: args.resourceId,
    })
    if (!missionId) return

    await this.prisma.missionEvent.create({
      data: {
        missionId,
        type: args.type,
        actorUserId: args.actorUserId,
        payload: args.payload,
      },
    })
  }

  private async resolveMissionIdForResource(args: {
    resourceKind: 'PAYMENT' | 'TRANSFER' | 'REFUND' | 'INVARIANT'
    resourceId: string
  }): Promise<string | null> {
    if (args.resourceKind !== 'INVARIANT' && !isUuidV4(args.resourceId)) {
      return null
    }
    if (args.resourceKind === 'PAYMENT') {
      const p = await this.prisma.payment.findUnique({
        where: { id: args.resourceId },
        select: { missionId: true },
      })
      return p?.missionId ?? null
    }
    if (args.resourceKind === 'TRANSFER') {
      const t = await this.prisma.transfer.findUnique({
        where: { id: args.resourceId },
        select: { payment: { select: { missionId: true } } },
      })
      return t?.payment.missionId ?? null
    }
    if (args.resourceKind === 'REFUND') {
      const r = await this.prisma.refund.findUnique({
        where: { id: args.resourceId },
        select: { payment: { select: { missionId: true } } },
      })
      return r?.payment.missionId ?? null
    }
    // INVARIANT / audit-only : pas de mission déterministe.
    return null
  }
}

/**
 * Build itération 2 — mapping `status → MissionEvent.type` pour l'audit trail.
 * Source de vérité unique (évite le ladder if/else).
 */
const AUDIT_EVENT_FOR_STATUS: Readonly<Record<FinanceMismatchStatus, string>> = Object.freeze({
  OPEN: FINANCE_AUDIT_EVENT_TYPES.mismatchInvestigating,
  ACKNOWLEDGED: FINANCE_AUDIT_EVENT_TYPES.mismatchAcknowledged,
  INVESTIGATING: FINANCE_AUDIT_EVENT_TYPES.mismatchInvestigating,
  RESOLVED: FINANCE_AUDIT_EVENT_TYPES.mismatchResolved,
  IGNORED: FINANCE_AUDIT_EVENT_TYPES.mismatchIgnored,
})

function isUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
}

function parseYyyyMmDdUtc(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || !mo || !d) return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (Number.isNaN(dt.getTime())) return null
  return dt
}
