/**
 * PRD-004 Ticket 4.1 (Build B) — Module BullBoard read-only sécurisé.
 *
 * Mount : `/api/internal/queues` (path final côté Express après prefix `/api`).
 *
 * Sécurité :
 *  1. `BullBoardAuthMiddleware` — JWT ADMIN ou INTERNAL_BEARER_TOKEN obligatoire.
 *  2. `BullBoardSanitizeMiddleware` — toute réponse JSON est passée par
 *     `deepSanitize` (defense-in-depth pour éviter exposition payloads futurs).
 *  3. **Read-only strict** — l'adapter BullMQ est instancié avec `readOnlyMode: true`
 *     (BullBoard refuse alors `retry` / `delete` / `promote` côté serveur).
 *  4. Queue list bornée — uniquement les queues réelles enregistrées au boot.
 *     Aucune wildcard / découverte dynamique.
 *
 * Feature flag : `BULL_BOARD_ENABLED` (défaut `false`). Si désactivé, le module
 * est importé mais ne mount aucune route → zéro surface d'attaque.
 *
 * Hors-scope Build B :
 *  - Queues `transfers` / `refunds` listées dans le ADR-015 mais qui n'existent
 *    pas encore comme files BullMQ séparées (le code transfer/refund tourne
 *    dans `StripeWebhookProcessor`). Documenté en TODO(debt).
 */

import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { InjectQueue } from '@nestjs/bullmq'
import {
  Logger,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import type { Queue } from 'bullmq'

import { loadEnv, type Env } from '../../../common/config/env'
import { AUTO_RELEASE_QUEUE } from '../../missions-completion/auto-release/auto-release.constants'
import { STRIPE_WEBHOOK_QUEUE } from '../../payments/payments.constants'

import { BullBoardAuthMiddleware } from './bullboard-auth.middleware'
import { BullBoardSanitizeMiddleware } from './bullboard-sanitize.middleware'

/**
 * Path final côté Express après le prefix global `/api` (cf. `main.ts`
 * `app.setGlobalPrefix('api', ...)`).
 *
 * **NB** : la sécurité ne dépend PAS du fait que ce path soit "internal".
 * C'est le middleware d'auth qui protège — le préfixe est cosmétique +
 * facilite le filtrage côté reverse-proxy (Nginx peut bloquer
 * `/api/internal/*` depuis l'extérieur en complément).
 */
export const BULL_BOARD_BASE_PATH = '/api/internal/queues'

@Module({
  imports: [JwtModule.register({})],
  providers: [BullBoardAuthMiddleware, BullBoardSanitizeMiddleware],
})
export class BullBoardModule implements NestModule {
  private readonly logger = new Logger(BullBoardModule.name)
  private readonly env: Env
  private board: ReturnType<typeof createBullBoard> | null = null
  private adapter: ExpressAdapter | null = null

  constructor(
    @InjectQueue(STRIPE_WEBHOOK_QUEUE) private readonly stripeQueue: Queue,
    @InjectQueue(AUTO_RELEASE_QUEUE) private readonly autoReleaseQueue: Queue,
  ) {
    this.env = loadEnv()
  }

  configure(consumer: MiddlewareConsumer): void {
    if (!this.env.BULL_BOARD_ENABLED) {
      this.logger.log('bullboard.disabled — set BULL_BOARD_ENABLED=true to mount /api/internal/queues')
      return
    }

    const adapter = new ExpressAdapter().setBasePath(BULL_BOARD_BASE_PATH)
    const board = createBullBoard({
      queues: [
        // PRD-004 Build B — readOnlyMode: true → BullBoard refuse retry/promote/delete
        // côté serveur même si l'UI affiche les boutons (defense-in-depth).
        new BullMQAdapter(this.stripeQueue, { readOnlyMode: true }),
        new BullMQAdapter(this.autoReleaseQueue, { readOnlyMode: true }),
      ],
      serverAdapter: adapter,
    })

    this.board = board
    this.adapter = adapter

    consumer
      .apply(BullBoardAuthMiddleware, BullBoardSanitizeMiddleware, adapter.getRouter())
      .forRoutes(`${BULL_BOARD_BASE_PATH}*`)

    this.logger.log(
      {
        path: BULL_BOARD_BASE_PATH,
        queues: [STRIPE_WEBHOOK_QUEUE, AUTO_RELEASE_QUEUE],
        readOnly: true,
      },
      'bullboard.mounted',
    )
  }

  /** @internal exposé pour les tests d'intégration. */
  getBoardForTests(): ReturnType<typeof createBullBoard> | null {
    return this.board
  }

  /** @internal exposé pour les tests d'intégration. */
  getAdapterForTests(): ExpressAdapter | null {
    return this.adapter
  }
}
