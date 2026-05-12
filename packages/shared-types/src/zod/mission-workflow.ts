/**
 * Codes erreur métier — workflow mission (start / complete) alignés OpenAPI PRD-003.
 * Distincts des `PhotoErrorCode` (quota / MIME / GPS).
 */

import { z } from 'zod'

export const missionWorkflowErrorCodeSchema = z.enum([
  'MISSING_REQUIRED_BEFORE_PHOTOS',
  'AFTER_REQUIRES_BEFORE',
])
export type MissionWorkflowErrorCode = z.infer<typeof missionWorkflowErrorCodeSchema>

export const missionWorkflowErrorResponseSchema = z
  .object({
    error: missionWorkflowErrorCodeSchema,
    reason: z.string().max(500).optional(),
  })
  .strict()
export type MissionWorkflowErrorResponse = z.infer<typeof missionWorkflowErrorResponseSchema>
