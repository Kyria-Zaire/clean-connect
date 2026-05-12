/**
 * Constantes du module Missions — codes erreur métier (PRD-002 Build).
 * Source de vérité côté contrat : `missionErrorCodeSchema` (`@cc/shared-types`).
 */

import type { MissionErrorCode } from '@cc/shared-types'

export const MISSION_ERROR_CODES: Record<MissionErrorCode, MissionErrorCode> = {
  MISSION_NOT_FOUND: 'MISSION_NOT_FOUND',
  MISSION_FORBIDDEN: 'MISSION_FORBIDDEN',
  MISSION_INVALID_STATE: 'MISSION_INVALID_STATE',
  MISSION_ALREADY_ACCEPTED: 'MISSION_ALREADY_ACCEPTED',
  MISSION_NOT_ELIGIBLE: 'MISSION_NOT_ELIGIBLE',
  MISSION_GEOCODING_FAILED: 'MISSION_GEOCODING_FAILED',
  MISSION_VALIDATION_FAILED: 'MISSION_VALIDATION_FAILED',
}
