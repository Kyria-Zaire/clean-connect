/**
 * MissionsModule — PRD-002 Build (création / publication / matching / accept / cancel).
 *
 * Importe `AuthModule` pour réutiliser `JwtAccessGuard` + `RolesGuard` exposés
 * par PRD-001 (sécurité unifiée).
 *
 * NB : pas de processeur BullMQ branché en MVP — l'expiration du listing est
 * couverte par `MissionsService.expireIfStillProposed()` (callable via cron /
 * job admin / processor BullMQ futur). Voir CHANGELOG `debt-listing-expiration-queue`.
 */

import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { AdminMissionsController } from './admin-missions.controller'
import { MissionsController } from './missions.controller'
import { MissionsRepository } from './missions.repository'
import { MissionsService } from './missions.service'
import { GeocoderService } from './services/geocoder.service'
import { MatchingService } from './services/matching.service'
import { MissionEventService } from './services/mission-event.service'
import { MissionNumberService } from './services/mission-number.service'
import { MissionViewService } from './services/mission-view.service'

@Module({
  imports: [AuthModule],
  controllers: [MissionsController, AdminMissionsController],
  providers: [
    MissionsRepository,
    MissionsService,
    MissionNumberService,
    MissionEventService,
    GeocoderService,
    MatchingService,
    MissionViewService,
  ],
  // PRD-003 Ticket 3.2 — `PaymentsModule` réutilise le repo + l'audit + le
  // matching pour orchestrer les transitions liées au paiement
  // (`DRAFT → PENDING_PAYMENT` puis webhook → `PUBLISHED`).
  // PRD-003 Ticket 3.4 — `MissionsCompletionModule` consomme
  // `MissionViewService` pour sérialiser les réponses `/complete /validate
  // /report-problem` (vue cohérente avec `MissionsController`).
  exports: [
    MissionsService,
    MissionsRepository,
    MissionEventService,
    MatchingService,
    MissionViewService,
  ],
})
export class MissionsModule {}
