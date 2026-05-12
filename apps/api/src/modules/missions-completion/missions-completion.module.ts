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
 *  - `PaymentsModule` (forwardRef) : `PaymentsService.requestCapture` dans
 *    `AutoReleaseExecutor`.
 *  - `AutoReleaseCoreModule` : queue + `AutoReleaseService` / repository
 *    (sans `PaymentsModule` — évite le cycle Nest avec les webhooks).
 *
 * Exports :
 *  - `AutoReleaseCoreModule` : ré-exporte `AutoReleaseService` pour les
 *    consommateurs du boundary completion.
 *  - `MissionPhotoQuotaService` : peut être utile à l'admin Ticket 3.5.
 */

import { forwardRef, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { MissionsModule } from '../missions/missions.module'
import { PaymentsModule } from '../payments/payments.module'

import { AutoReleaseCoreModule } from './auto-release/auto-release-core.module'
import { AutoReleaseSafetyNetScheduler } from './auto-release/auto-release-safety-net.scheduler'
import { AutoReleaseExecutor } from './auto-release/auto-release.executor'
import { AutoReleaseProcessor } from './auto-release/auto-release.processor'
import { MissionCompletionController } from './mission-completion.controller'
import { MissionCompletionService } from './mission-completion.service'
import { MissionPhotoQuotaService } from './photo-quota.service'

@Module({
  imports: [
    AuthModule,
    MissionsModule,
    forwardRef(() => PaymentsModule),
    AutoReleaseCoreModule,
  ],
  controllers: [MissionCompletionController],
  providers: [
    AutoReleaseExecutor,
    AutoReleaseProcessor,
    AutoReleaseSafetyNetScheduler,
    MissionPhotoQuotaService,
    MissionCompletionService,
  ],
  exports: [AutoReleaseCoreModule, MissionPhotoQuotaService],
})
export class MissionsCompletionModule {}
