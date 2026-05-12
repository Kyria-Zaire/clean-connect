/**
 * PRD-003 — `AutoReleaseCoreModule` (sous-graphe DI sans `PaymentsModule`).
 *
 * `AutoReleaseService` annule les jobs Bull d’auto-release depuis
 * `PaymentDomainHandler` (webhook capture). L’inclure via
 * `MissionsCompletionModule` créait un cycle Nest
 * `PaymentsModule` ↔ `MissionsCompletionModule` (stack overflow au bootstrap).
 *
 * Ce module n’importe pas les paiements : uniquement la queue + repository +
 * service producteur. `AutoReleaseExecutor` / `AutoReleaseProcessor` restent
 * dans `MissionsCompletionModule` (ils injectent `PaymentsService`).
 */

import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'

import { AUTO_RELEASE_QUEUE } from './auto-release.constants'
import { AutoReleaseJobRepository } from './auto-release.repository'
import { AutoReleaseService } from './auto-release.service'

@Module({
  imports: [
    BullModule.registerQueue({
      name: AUTO_RELEASE_QUEUE,
      defaultJobOptions: {
        removeOnFail: false,
      },
    }),
  ],
  providers: [AutoReleaseJobRepository, AutoReleaseService],
  exports: [AutoReleaseService, AutoReleaseJobRepository],
})
export class AutoReleaseCoreModule {}
