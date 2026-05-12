/**
 * PRD-003 Ticket 3.4 — erreurs métier `MissionCompletionService` /
 * controller. Codes alignés `missionErrorCodeSchema` (@cc/shared-types).
 *
 * Conventions :
 *  - `code` exposé dans le body via `error`.
 *  - `reason` optionnel pour le détail métier — JAMAIS de message Stripe brut.
 */

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'

/** Mission n'est pas dans l'état requis (`ACCEPTED` pour `/complete`). */
export class MissionNotCompletableException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'MISSION_NOT_COMPLETABLE', reason })
  }
}

/** Mission n'est pas dans l'état requis (`CLIENT_VALIDATION_PENDING` pour `/validate`). */
export class MissionNotValidatableException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'MISSION_NOT_VALIDATABLE', reason })
  }
}

/**
 * Photos BEFORE/AFTER insuffisantes pour passer en `CLIENT_VALIDATION_PENDING`
 * (≥ 3 BEFORE + ≥ 5 AFTER — Design §3.5 + ADR-009). Le mobile doit s'assurer
 * de la sync complète AVANT d'appeler `/complete` (file MMKV).
 */
export class MissionPhotosInsufficientException extends ConflictException {
  constructor(reason: string) {
    super({ error: 'MISSION_PHOTOS_INSUFFICIENT', reason })
  }
}

/** L'acteur n'est pas le `clientId` de la mission (ownership). */
export class MissionClientOnlyException extends ForbiddenException {
  constructor() {
    super({ error: 'MISSION_CLIENT_ONLY' })
  }
}

/** L'acteur n'est pas le `prestataireId` de la mission (ownership). */
export class MissionPrestataireOnlyException extends ForbiddenException {
  constructor() {
    super({ error: 'MISSION_PRESTATAIRE_ONLY' })
  }
}

/** Litige déjà ouvert sur la mission — pas de double dispute. */
export class MissionDisputeAlreadyOpenException extends ConflictException {
  constructor() {
    super({ error: 'MISSION_DISPUTE_ALREADY_OPEN' })
  }
}

/**
 * Payload `category` ou `description` invalide pour `/report-problem`.
 * Le `ZodValidationPipe` lève déjà 400 sur le body — cette exception ne
 * sert qu'aux validations sémantiques côté service (ex: catégorie marquée
 * obsolète plus tard).
 */
export class MissionReportProblemBadInputException extends BadRequestException {
  constructor(reason: string) {
    super({ error: 'MISSION_REPORT_PROBLEM_BAD_INPUT', reason })
  }
}
