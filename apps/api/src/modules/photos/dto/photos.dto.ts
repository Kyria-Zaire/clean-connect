/**
 * PRD-003 Ticket 3.3 — DTOs HTTP nestjs-zod pour `PhotosController`.
 * Les schémas Zod sources sont dans `@cc/shared-types` (source de vérité).
 */

import {
  confirmPhotoUploadInputSchema,
  presignPhotoUploadInputSchema,
} from '@cc/shared-types'
import { createZodDto } from 'nestjs-zod'

export class PresignPhotoUploadBodyDto extends createZodDto(presignPhotoUploadInputSchema) {}

export class ConfirmPhotoUploadBodyDto extends createZodDto(confirmPhotoUploadInputSchema) {}
