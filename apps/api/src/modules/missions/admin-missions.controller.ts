/**
 * AdminMissionsController — endpoints réservés ADMIN (PRD-002 Build).
 *
 * Contrainte CTO Build §7 : aucune logique métier ici. Délégation `MissionsService`.
 *
 * Préfixé `/api/v1/admin/missions/*`. Le rôle est imposé via `@Roles(ADMIN)` ;
 * tout autre rôle reçoit `403 Forbidden` (RolesGuard).
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger'
import { Role } from '@prisma/client'

import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type'

import { MissionListQueryDto, MissionListResponseDto } from './dto/missions.dto'
import { MissionsService } from './missions.service'

@ApiTags('admin-missions')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller('admin/missions')
export class AdminMissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Liste paginée toutes missions (ADMIN)' })
  @ApiOkResponse({ type: MissionListResponseDto })
  async list(
    @Query() query: MissionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionListResponseDto> {
    return this.missions.listAdmin({ userId: user.id, role: user.role }, query)
  }
}
