import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD, APP_PIPE } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { ZodValidationPipe } from 'nestjs-zod'

import { loadEnv } from './common/config/env'
import { ConditionalThrottlerGuard } from './common/guards/conditional-throttler.guard'
import { getCurrentTraceId } from './common/logger/correlation'
import { pinoLogFormatter } from './common/logger/log-sanitizer'
import { REDACTION_CENSOR, REDACTION_PATHS } from './common/logger/redaction'
import { PrismaModule } from './common/prisma/prisma.module'
import { AuthModule } from './modules/auth/auth.module'
import { HealthModule } from './modules/health/health.module'
import { MissionsModule } from './modules/missions/missions.module'
import { MissionsCompletionModule } from './modules/missions-completion/missions-completion.module'
import { BullBoardModule } from './modules/observability/bullboard/bullboard.module'
import { ObservabilityModule } from './modules/observability/observability.module'
import { PaymentsModule } from './modules/payments/payments.module'
import { PhotosModule } from './modules/photos/photos.module'
import { UsersModule } from './modules/users/users.module'

const env = loadEnv()

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: () => loadEnv(),
    }),
    /**
     * Pino structured logging — PRD-004 Ticket 4.1 Build A2.
     *
     * - Production : JSON ligne par événement (LOG_LEVEL=info), pas de
     *   `pino-pretty` (coûteux + couleurs inutiles en agrégation).
     * - Development : `pino-pretty` lisible pour debug local.
     * - Redaction exhaustive : voir `common/logger/redaction.ts` (classes
     *   A/B/C — ADR-016). Toute clé sensible ajoutée doit y être listée.
     * - Corrélation : `requestId` lu depuis `req.requestId` (posé par
     *   `RequestIdMiddleware`, A1) ; `traceId` lu depuis le span Sentry/OTel
     *   actif (`getCurrentTraceId`). Quand pas de span actif → champ omis.
     */
    LoggerModule.forRootAsync({
      useFactory: () => {
        const env = loadEnv()
        return {
          pinoHttp: {
            level: env.LOG_LEVEL,
            transport:
              env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
                : undefined,
            // Réutilise le `requestId` UUID posé par `RequestIdMiddleware`.
            // Le typage `unknown` ici est une rustine `pino-http` : la
            // signature attend `IncomingMessage`, et `req.requestId` est
            // attaché via augmentation Express.
            genReqId: (req: unknown): string => {
              const r = req as { requestId?: string }
              return r.requestId ?? 'unknown'
            },
            // Ajoute `traceId` à chaque ligne de log HTTP — `requestId` est
            // déjà émis par Pino via `genReqId` (sous le champ `req.id`).
            customProps: () => {
              const traceId = getCurrentTraceId()
              return traceId ? { traceId } : {}
            },
            redact: {
              paths: [...REDACTION_PATHS],
              censor: REDACTION_CENSOR,
            },
            // Formatter dédié : traversée récursive (cycles + DoS bornés).
            // Couvre tous les payloads profonds (BullMQ jobs, webhook Stripe)
            // que `fast-redact` (paths plats) ne peut pas atteindre.
            formatters: {
              log: pinoLogFormatter,
            },
          },
        }
      },
    }),
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        const env = loadEnv()
        return [
          {
            ttl: env.THROTTLE_TTL_SECONDS * 1000,
            limit: env.THROTTLE_LIMIT,
          },
        ]
      },
    }),
    /**
     * BullMQ — connexion Redis globale partagée (PRD-003 Ticket 3.1).
     *
     * `prefix` permet d'isoler les clés par environnement (recette / preprod / prod)
     * partageant un même Redis ; en dev local on n'a qu'une instance donc le préfixe
     * reste utile pour le namespace.
     */
    BullModule.forRootAsync({
      useFactory: () => {
        const env = loadEnv()
        const url = new URL(env.REDIS_URL)
        return {
          connection: {
            host: url.hostname,
            port: url.port ? Number(url.port) : 6379,
            password: url.password || undefined,
            // `maxRetriesPerRequest` doit être `null` pour les workers BullMQ
            // (sinon ioredis perd les jobs en queue lors d'un déconnect transitoire).
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
          prefix: `cc:${env.APP_ENV}`,
        }
      },
    }),
    /**
     * PRD-004 Ticket 4.1 (A1) — Observability foundation : Sentry + middleware
     * `requestId`. Importé en premier (avant les domain modules) pour que le
     * middleware soit appliqué globalement, y compris sur `/healthz`.
     */
    ObservabilityModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MissionsModule,
    /**
     * PRD-003 Ticket 3.1 — module Payments gated par `FF_PAYMENTS_ENABLED`.
     */
    PaymentsModule,
    /**
     * PRD-003 Ticket 3.3 — module Photos (Cloudinary signed upload +
     * PhotoUploadSession). Gated par `FF_PHOTOS_ENABLED` au niveau service.
     */
    PhotosModule,
    /**
     * PRD-003 Ticket 3.4 — module MissionsCompletion (complete / validate /
     * report-problem + AutoReleaseJob BullMQ delayed T+48h ouvrées).
     */
    MissionsCompletionModule,
    /**
     * PRD-004 Ticket 4.1 (Build B) — BullBoard read-only sécurisé, monté UNIQUEMENT
     * si `BULL_BOARD_ENABLED=true`. Sinon le module est importé mais ne mount
     * aucune route (zéro surface d'attaque par défaut).
     *
     * NB : enregistré conditionnellement pour éviter d'injecter les queues
     * (`@InjectQueue`) côté tests unitaires/intégration qui ne mock pas BullMQ.
     */
    ...(env.BULL_BOARD_ENABLED ? [BullBoardModule] : []),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ConditionalThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
