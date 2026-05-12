/**
 * PRD-003 Ticket 3.3 — Controller `Photos` (presign + confirm).
 *
 * Endpoints :
 *  - `POST /v1/missions/:id/photos/presign` (PRESTATAIRE assigned / ADMIN)
 *  - `POST /v1/missions/:id/photos/confirm` (PRESTATAIRE assigned / ADMIN)
 *
 * Contrainte CTO Build §7 — HTTP I/O uniquement. RBAC effectif est porté
 * par le service (vérification mission.prestataireId === user.id), ce qui
 * suit la rule architecte-api (ownership = service-level).
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
  ConfirmPhotoUploadBodyDto,
  PresignPhotoUploadBodyDto,
} from './dto/photos.dto'
import { PhotosService } from './photos.service'

@ApiTags('photos')
@ApiBearerAuth('access-jwt')
@UseGuards(JwtAccessGuard, RolesGuard)
@Controller({ path: 'missions', version: '1' })
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post(':id/photos/presign')
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pré-signer un upload Cloudinary pour une mission (PRESTATAIRE assigned)',
  })
  @ApiResponse({ status: 201, description: 'PhotoUploadSignatureResponse' })
  @ApiResponse({ status: 400, description: 'PHOTO_MIME_NOT_ALLOWED / PHOTO_MAX_BYTES_EXCEEDED' })
  @ApiResponse({ status: 403, description: 'PHOTO_FORBIDDEN — non assigné à la mission' })
  @ApiResponse({ status: 404, description: 'PHOTO_NOT_FOUND — mission introuvable' })
  @ApiResponse({ status: 503, description: 'PHOTOS_DISABLED — FF_PHOTOS_ENABLED=false' })
  async presign(
    @Param('id', ParseUUIDPipe) missionId: string,
    @Body() body: PresignPhotoUploadBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.photos.presign(missionId, { id: user.id, role: user.role }, body)
  }

  @Post(':id/photos/confirm')
  @Roles(Role.PRESTATAIRE, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Confirmer un upload Cloudinary (consume PhotoUploadSession)',
  })
  @ApiResponse({ status: 201, description: 'ConfirmPhotoUploadResponse' })
  @ApiResponse({ status: 403, description: 'PHOTO_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'PHOTO_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'PHOTO_UPLOAD_SESSION_ALREADY_CONSUMED / PHOTO_UPLOAD_SESSION_MISSION_MISMATCH / PHOTO_CAPTURE_CLIENT_UUID_SESSION_MISMATCH',
  })
  @ApiResponse({ status: 410, description: 'PHOTO_UPLOAD_SESSION_EXPIRED — TTL 5 min dépassé' })
  @ApiResponse({ status: 422, description: 'PHOTO_INVALID_STATE — anti-spoof Cloudinary' })
  @ApiResponse({ status: 503, description: 'PHOTOS_DISABLED' })
  async confirm(
    @Param('id', ParseUUIDPipe) missionId: string,
    @Body() body: ConfirmPhotoUploadBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.photos.confirm(missionId, { id: user.id, role: user.role }, body)
  }
}
