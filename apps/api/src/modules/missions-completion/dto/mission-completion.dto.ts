/**
 * PRD-003 Ticket 3.4 — DTOs HTTP `MissionCompletion`.
 *
 * Source de vérité Zod : `packages/shared-types/src/zod/mission.ts`.
 * Les classes générées via `createZodDto` sont consommées par le
 * `ZodValidationPipe` global + `patchNestJsSwagger()`.
 */

import {
  completeMissionBodySchema,
  missionCompletionResponseSchemaFactory,
  missionViewSchema,
  reportMissionProblemBodySchema,
  validateMissionBodySchema,
} from '@cc/shared-types'
import { createZodDto } from 'nestjs-zod'

export class CompleteMissionBodyDto extends createZodDto(completeMissionBodySchema) {}
export class ValidateMissionBodyDto extends createZodDto(validateMissionBodySchema) {}
export class ReportMissionProblemBodyDto extends createZodDto(reportMissionProblemBodySchema) {}

/**
 * Réponse commune `/complete`, `/validate`, `/report-problem` —
 * `{ mission: MissionView, idempotent: boolean }`.
 */
export class MissionCompletionResponseDto extends createZodDto(
  missionCompletionResponseSchemaFactory(missionViewSchema),
) {}
