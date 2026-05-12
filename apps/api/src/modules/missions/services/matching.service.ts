/**
 * MatchingService — exécute le matching PostGIS pour une mission donnée.
 *
 * Contraintes CTO Build :
 *  - §3 : pagination obligatoire, limite obligatoire (no full-scan, no radius illimité).
 *  - §5 : exclure providers suspendus / soft-deleted / non vérifiés (FAIT côté SQL,
 *         cf. `MissionsRepository.findEligiblePrestataires`).
 *  - §4 : aucune adresse complète dans logs/audit (vérifié par
 *         `assertNoAddressLeak` côté `MissionEventService`).
 *
 * Stratégie marketplace first-accept-wins (ADR-005) : on insère N propositions
 * (jusqu'à `MATCHING_MAX_PROVIDERS`) ; la mission reste en `PUBLISHED` jusqu'à
 * acceptation (ou expiration listing). Pas de notification poussée en MVP — la
 * liste est consommée par les prestataires via `GET /missions/proposed`.
 */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import type { Env } from '../../../common/config/env'
import { PrismaService } from '../../../common/prisma/prisma.service'
import { MissionsRepository } from '../missions.repository'

import { MissionEventService } from './mission-event.service'

export interface MatchingResult {
  missionId: string
  proposalsCreated: number
  matchedCount: number
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name)
  private readonly maxProviders: number

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MissionsRepository,
    private readonly events: MissionEventService,
    config: ConfigService<Env, true>,
  ) {
    this.maxProviders = config.get('MATCHING_MAX_PROVIDERS', { infer: true })
  }

  /**
   * Calcule les éligibles, insère les `MissionProposal`, écrit l'évènement audit
   * `MATCHING_DONE`. Idempotent : `skipDuplicates: true` côté repo.
   */
  async runFor(missionId: string): Promise<MatchingResult> {
    const eligible = await this.repo.findEligiblePrestataires({
      missionId,
      limit: this.maxProviders,
    })

    const ids = eligible.map((row) => row.id)

    const proposalsCreated = await this.prisma.$transaction(async (tx) => {
      const created = await this.repo.insertProposalsTx(tx, missionId, ids)
      await this.events.recordTx(tx, {
        missionId,
        type: 'MATCHING_DONE',
        actorUserId: null,
        payload: {
          matchedCount: ids.length,
          proposalsCreated: created,
          maxProviders: this.maxProviders,
        },
      })
      return created
    })

    this.logger.log({
      event: 'mission.matching.completed',
      missionId,
      matchedCount: ids.length,
      proposalsCreated,
    })

    return { missionId, proposalsCreated, matchedCount: ids.length }
  }
}
