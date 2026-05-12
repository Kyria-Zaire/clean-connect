/**
 * PRD-003 Ticket 3.4 — Controller HTTP `MissionCompletion`.
 *
 * Endpoints :
 *  - `POST /v1/missions/:id/complete`        (PRESTATAIRE)
 *  - `POST /v1/missions/:id/validate`        (CLIENT)
 *  - `POST /v1/missions/:id/report-problem`  (CLIENT)
 *
 * Le controller est strict HTTP I/O — toute la logique métier est dans
 * `MissionCompletionService` (rule architecte-api §découpage).
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
  CompleteMissionBodyDto,
  MissionCompletionResponseDto,
  ReportMissionProblemBodyDto,
  ValidateMissionBodyDto,
} from './dto/mission-completion.dto'
import { MissionCompletionService } from './mission-completion.service'

@ApiTags('missions')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller('missions')
export class MissionCompletionController {
  constructor(private readonly completion: MissionCompletionService) {}

  @Post(':id/complete')
  @Roles(Role.PRESTATAIRE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'PRD-003 Ticket 3.4 — PRESTATAIRE signale la fin de la prestation (ACCEPTED → CLIENT_VALIDATION_PENDING).',
    description:
      'Pré-conditions : prestataire assigné + ≥ 3 photos BEFORE + ≥ 5 photos AFTER synchronisées (`syncedAt IS NOT NULL`). Idempotent (retry mobile safe).\n\n' +
      'Effets : planifie le job auto-release T+48h ouvrées Europe/Paris (BullMQ delayed) — sera annulé par `/validate` ou `/report-problem`.',
  })
  @ApiOkResponse({ type: MissionCompletionResponseDto })
  @ApiResponse({ status: 403, description: 'MISSION_PRESTATAIRE_ONLY' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'MISSION_NOT_COMPLETABLE | MISSION_PHOTOS_INSUFFICIENT',
  })
  async complete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() _body: CompleteMissionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionCompletionResponseDto> {
    return this.completion.complete(id, { userId: user.id, role: user.role })
  }

  @Post(':id/validate')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'PRD-003 Ticket 3.4 — CLIENT valide manuellement → capture PaymentIntent (SYSTEM trigger=CLIENT_VALIDATION).',
    description:
      'Annule le job auto-release BullMQ puis appelle `stripe.paymentIntents.capture(intent.id, { idempotencyKey: capture-mission-<id> })` (idempotent côté Stripe et serveur).\n\n' +
      'La mission reste en `CLIENT_VALIDATION_PENDING` jusqu\'au webhook `payment_intent.succeeded` qui la fait passer en `COMPLETED`.',
  })
  @ApiOkResponse({ type: MissionCompletionResponseDto })
  @ApiResponse({ status: 403, description: 'MISSION_CLIENT_ONLY' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MISSION_NOT_VALIDATABLE | PAYMENT_NOT_CAPTURABLE' })
  @ApiResponse({
    status: 422,
    description: 'PAYMENT_AUTHORIZATION_EXPIRED | PAYMENT_STRIPE_ERROR',
  })
  async validate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() _body: ValidateMissionBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionCompletionResponseDto> {
    return this.completion.validate(id, { userId: user.id, role: user.role })
  }

  @Post(':id/report-problem')
  @Roles(Role.CLIENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'PRD-003 Ticket 3.4 — CLIENT signale un problème → CLIENT_VALIDATION_PENDING → DISPUTE_OPEN.',
    description:
      'Annule le job auto-release et bloque toute capture future. Workflow d\'instruction admin = PRD-005.\n\n' +
      'La `description` est validée (10-1000 caractères) mais JAMAIS auditée en clair (rule securite — PII).',
  })
  @ApiOkResponse({ type: MissionCompletionResponseDto })
  @ApiResponse({ status: 403, description: 'MISSION_CLIENT_ONLY' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'MISSION_NOT_VALIDATABLE | MISSION_DISPUTE_ALREADY_OPEN',
  })
  async reportProblem(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: ReportMissionProblemBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MissionCompletionResponseDto> {
    return this.completion.reportProblem(id, { userId: user.id, role: user.role }, body)
  }
}
