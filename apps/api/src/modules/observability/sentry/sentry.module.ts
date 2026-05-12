/**
 * Module Nest — Observability / Sentry (PRD-004 Ticket 4.1 — Build A1).
 *
 * Responsabilités :
 * - Brancher le middleware `RequestIdMiddleware` sur toutes les routes (avant
 *   tout controller).
 * - Centraliser l'accès à `@sentry/node` côté DI (tests faciles à mocker).
 *
 * Note : l'init effective de Sentry se fait dans `main.ts` **avant** le boot
 * Nest (auto-instrumentation OTel doit s'attacher au plus tôt). Ce module
 * ne fait que le câblage Nest.
 */

import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'

import { RequestIdMiddleware } from '../../../common/middlewares/request-id.middleware'

@Module({})
export class SentryModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
