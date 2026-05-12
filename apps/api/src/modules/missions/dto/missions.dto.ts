/**
 * DTOs HTTP du module Missions — pilotés par les schémas Zod de `@cc/shared-types`.
 * `createZodDto` produit la classe consommable par `ZodValidationPipe` global et
 * par Swagger (via `patchNestJsSwagger()`).
 *
 * Source de vérité : packages/shared-types/src/zod/mission.ts
 */

import {
  acceptMissionBodySchema,
  cancelMissionBodySchema,
  createMissionDraftBodySchema,
  missionListQuerySchema,
  missionListResponseSchema,
  missionViewSchema,
  publishMissionBodySchema,
} from '@cc/shared-types'
import { createZodDto } from 'nestjs-zod'

export class CreateMissionDraftBodyDto extends createZodDto(createMissionDraftBodySchema) {}
export class PublishMissionBodyDto extends createZodDto(publishMissionBodySchema) {}
export class AcceptMissionBodyDto extends createZodDto(acceptMissionBodySchema) {}
export class CancelMissionBodyDto extends createZodDto(cancelMissionBodySchema) {}

export class MissionListQueryDto extends createZodDto(missionListQuerySchema) {}

export class MissionViewResponseDto extends createZodDto(missionViewSchema) {}
export class MissionListResponseDto extends createZodDto(missionListResponseSchema) {}
