/**
 * MissionEventService — audit minimal du cycle de vie mission.
 *
 * Contrainte CTO Build §1 : `MissionEvent { missionId, type, actorUserId, payload, createdAt }`.
 * Contrainte CTO Build §4 : aucune adresse complète dans le payload audit
 * (vérification systématique via `assertNoAddressLeak`).
 *
 * Conçu pour être consommé en `$transaction` Prisma : `recordTx()` accepte un
 * `tx` Prisma et rejoint la même transaction que la mutation métier.
 */

import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../../../common/prisma/prisma.service'
import { assertNoAddressLeak, type MissionEventInput } from '../domain/mission-event.types'

type PrismaTx = Prisma.TransactionClient | PrismaService

@Injectable()
export class MissionEventService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: MissionEventInput): Promise<void> {
    await this.recordTx(this.prisma, input)
  }

  async recordTx(tx: PrismaTx, input: MissionEventInput): Promise<void> {
    if (input.payload) assertNoAddressLeak(input.payload)
    await tx.missionEvent.create({
      data: {
        missionId: input.missionId,
        type: input.type,
        actorUserId: input.actorUserId,
        payload:
          input.payload === undefined || input.payload === null
            ? Prisma.JsonNull
            : (input.payload as Prisma.InputJsonValue),
      },
    })
  }
}
