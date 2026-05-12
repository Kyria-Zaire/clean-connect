/**
 * HttpExceptions métier mission — wrappers typés avec `error: MissionErrorCode`.
 * Garantit un body homogène consommé par `AllExceptionsFilter` (déjà gère
 * `getResponse() => { error, message }`).
 */

import { ForbiddenException, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common'

import { MISSION_ERROR_CODES } from './missions.constants'

export class MissionNotFoundError extends NotFoundException {
  constructor() {
    super({ error: MISSION_ERROR_CODES.MISSION_NOT_FOUND })
  }
}

export class MissionForbiddenError extends ForbiddenException {
  constructor() {
    super({ error: MISSION_ERROR_CODES.MISSION_FORBIDDEN })
  }
}

export class MissionInvalidStateError extends ConflictException {
  constructor(reason?: string) {
    super({ error: MISSION_ERROR_CODES.MISSION_INVALID_STATE, reason })
  }
}

export class MissionAlreadyAcceptedError extends ConflictException {
  constructor() {
    super({ error: MISSION_ERROR_CODES.MISSION_ALREADY_ACCEPTED })
  }
}

export class MissionNotEligibleError extends ForbiddenException {
  constructor() {
    super({ error: MISSION_ERROR_CODES.MISSION_NOT_ELIGIBLE })
  }
}

export class MissionGeocodingFailedError extends BadRequestException {
  constructor() {
    super({ error: MISSION_ERROR_CODES.MISSION_GEOCODING_FAILED })
  }
}

export class MissionValidationFailedError extends BadRequestException {
  constructor(reason: string) {
    super({ error: MISSION_ERROR_CODES.MISSION_VALIDATION_FAILED, reason })
  }
}
