/**
 * MissionsController — endpoints CRUD + transitions du PRD-002 Build.
 *
 * Contrainte CTO Build §7 : aucune logique métier ici. Le controller :
 *   1. Valide l'input (DTO Zod via `ZodValidationPipe` global).
 *   2. Vérifie l'authentification (JwtAccessGuard) + RBAC (RolesGuard).
 *   3. Délègue au service.
 *   4. Retourne le DTO réponse.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  AcceptMissionBodyDto,
  CancelMissionBodyDto,
  CreateMissionDraftBodyDto,
  MissionListQueryDto,
  MissionListResponseDto,
  MissionViewResponseDto,
  PublishMissionBodyDto,
} from './dto/missions.dto'
import { MissionsService } from './missions.service'

@ApiTags('missions')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller('missions')
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  // ---------------------------------------------------------------------------
  // CLIENT — création / cycle de vie
  // ---------------------------------------------------------------------------

  @Post()
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer une mission en brouillon (CLIENT)' })
  @ApiResponse({ status: 201, type: MissionViewResponseDto })
  @ApiResponse({ status: 400, description: 'Validation Zod ou géocodage BAN échoué.' })
  @ApiResponse({ status: 403, description: 'Rôle non autorisé.' })
  async createDraft(
    @Body() body: CreateMissionDraftBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionViewResponseDto> {
    return this.missions.createDraft(body, { userId: user.id, role: user.role })
  }

  @Post(':id/publish')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publier la mission et lancer le matching (CLIENT)' })
  @ApiOkResponse({ type: MissionViewResponseDto })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 403, description: 'MISSION_FORBIDDEN' })
  @ApiResponse({ status: 409, description: 'MISSION_INVALID_STATE' })
  async publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() _body: PublishMissionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionViewResponseDto> {
    return this.missions.publish(id, { userId: user.id, role: user.role })
  }

  @Delete(':id')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Annuler une mission (DRAFT/PUBLISHED, CLIENT)' })
  @ApiOkResponse({ type: MissionViewResponseDto })
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: CancelMissionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionViewResponseDto> {
    return this.missions.cancel(id, { userId: user.id, role: user.role }, body.reason)
  }

  @Get('mine')
  @Roles(Role.CLIENT)
  @ApiOperation({ summary: 'Liste paginée des missions de l\'utilisateur (CLIENT)' })
  @ApiOkResponse({ type: MissionListResponseDto })
  async listMine(
    @Query() query: MissionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionListResponseDto> {
    return this.missions.listMine({ userId: user.id, role: user.role }, query)
  }

  // ---------------------------------------------------------------------------
  // PRESTATAIRE — propositions / acceptation
  // ---------------------------------------------------------------------------

  @Get('proposed')
  @Roles(Role.PRESTATAIRE)
  @ApiOperation({ summary: 'Missions proposées au prestataire (PRESTATAIRE)' })
  @ApiOkResponse({ type: MissionListResponseDto })
  async listProposed(
    @Query() query: MissionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionListResponseDto> {
    return this.missions.listProposed({ userId: user.id, role: user.role }, query)
  }

  @Post(':id/accept')
  @Roles(Role.PRESTATAIRE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accepter une mission (lock optimiste — first wins)' })
  @ApiOkResponse({ type: MissionViewResponseDto })
  @ApiResponse({ status: 409, description: 'MISSION_ALREADY_ACCEPTED' })
  @ApiResponse({ status: 403, description: 'MISSION_NOT_ELIGIBLE / MISSION_FORBIDDEN' })
  async accept(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() _body: AcceptMissionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionViewResponseDto> {
    return this.missions.accept(id, { userId: user.id, role: user.role })
  }

  // ---------------------------------------------------------------------------
  // GETTER générique (RBAC dans le service)
  // ---------------------------------------------------------------------------

  @Get(':id')
  @Roles(Role.CLIENT, Role.PRESTATAIRE, Role.ADMIN)
  @ApiOperation({ summary: 'Détail d\'une mission (RBAC + masquage adresse)' })
  @ApiOkResponse({ type: MissionViewResponseDto })
  async getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionViewResponseDto> {
    return this.missions.getById(id, { userId: user.id, role: user.role })
  }
}
