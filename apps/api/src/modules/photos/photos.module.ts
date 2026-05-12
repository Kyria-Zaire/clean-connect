/**
 * PRD-003 Ticket 3.3 — `PhotosModule`.
 *
 * Le module est chargé même si `FF_PHOTOS_ENABLED=false` (Nest exige un graph
 * statique). Le gating se fait au service : `PhotosService.assertEnabled()`
 * lève `503 PHOTOS_DISABLED` avant tout effet de bord.
 *
 * Imports :
 *  - `AuthModule` : `JwtAccessGuard` global, `RolesGuard`.
 *  - `MissionsModule` : `MissionEventService` (audit `PHOTO_UPLOAD_PRESIGNED` /
 *    `PHOTO_CONFIRMED`).
 */

import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { MissionsModule } from '../missions/missions.module'

import {
  CLOUDINARY_CLIENT_TOKEN,
  CloudinaryClient,
  CloudinaryClientFactory,
} from './cloudinary/cloudinary.client'
import { PhotoUploadSessionCleanupScheduler } from './photo-upload-session-cleanup.scheduler'
import { PhotosController } from './photos.controller'
import { PhotosRepository } from './photos.repository'
import { PhotosService } from './photos.service'

@Module({
  imports: [AuthModule, MissionsModule],
  controllers: [PhotosController],
  providers: [
    CloudinaryClientFactory,
    {
      provide: CLOUDINARY_CLIENT_TOKEN,
      useFactory: (factory: CloudinaryClientFactory) => factory.build(),
      inject: [CloudinaryClientFactory],
    },
    {
      provide: CloudinaryClient,
      useExisting: CLOUDINARY_CLIENT_TOKEN,
    },
    PhotosRepository,
    PhotosService,
    PhotoUploadSessionCleanupScheduler,
  ],
  exports: [PhotosService],
})
export class PhotosModule {}
