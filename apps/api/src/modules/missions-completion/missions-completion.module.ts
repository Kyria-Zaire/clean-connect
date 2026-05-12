/**
 * PRD-003 Ticket 3.4 — `MissionsCompletionModule`.
 *
 * Boundary fonctionnel : tout ce qui touche à la fin de mission
 *   (complete / validate / report-problem) + auto-release BullMQ.
 *
 * Dépendances :
 *  - `MissionsModule` : `MissionsRepository`, `MissionViewService`,
 *    `MissionEventService` (réutilisés tels quels).
 *  - `AuthModule` : guards JWT + RolesGuard.
 *  - `PaymentsModule` (forwardRef) : `PaymentsService.requestCapture` —
 *    cycle avec `PaymentDomainHandler.onCaptured` qui appelle
 *    `AutoReleaseService.cancel`.
 *  - `BullModule.registerQueue(AUTO_RELEASE_QUEUE)` : delayed jobs
 *    auto-release T+48h ouvrées.
 *
 * Exports :
 *  - `AutoReleaseService` : utilisé par `PaymentDomainHandler` (cancel
 *    sur `payment_intent.succeeded`).
 *  - `MissionPhotoQuotaService` : peut être utile à l'admin Ticket 3.5.
 */

import { BullModule } from '@nestjs/bullmq'
import { forwardRef, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { MissionsModule } from '../missions/missions.module'
import { PaymentsModule } from '../payments/payments.module'

import { AUTO_RELEASE_QUEUE } from './auto-release/auto-release.constants'
import { AutoReleaseExecutor } from './auto-release/auto-release.executor'
import { AutoReleaseProcessor } from './auto-release/auto-release.processor'
import { AutoReleaseJobRepository } from './auto-release/auto-release.repository'
import { AutoReleaseService } from './auto-release/auto-release.service'
import { MissionCompletionController } from './mission-completion.controller'
import { MissionCompletionService } from './mission-completion.service'
import { MissionPhotoQuotaService } from './photo-quota.service'

@Module({
  imports: [
    AuthModule,
    MissionsModule,
    forwardRef(() => PaymentsModule),
    BullModule.registerQueue({
      name: AUTO_RELEASE_QUEUE,
      defaultJobOptions: {
        removeOnFail: false,
      },
    }),
  ],
  controllers: [MissionCompletionController],
  providers: [
    AutoReleaseJobRepository,
    AutoReleaseService,
    AutoReleaseExecutor,
    AutoReleaseProcessor,
    MissionPhotoQuotaService,
    MissionCompletionService,
  ],
  exports: [AutoReleaseService, MissionPhotoQuotaService],
})
export class MissionsCompletionModule {}
