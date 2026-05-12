import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD, APP_PIPE } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { ZodValidationPipe } from 'nestjs-zod'

import { loadEnv } from './common/config/env'
import { ConditionalThrottlerGuard } from './common/guards/conditional-throttler.guard'
import { PrismaModule } from './common/prisma/prisma.module'
import { AuthModule } from './modules/auth/auth.module'
import { HealthModule } from './modules/health/health.module'
import { MissionsModule } from './modules/missions/missions.module'
import { MissionsCompletionModule } from './modules/missions-completion/missions-completion.module'
import { PaymentsModule } from './modules/payments/payments.module'
import { PhotosModule } from './modules/photos/photos.module'
import { UsersModule } from './modules/users/users.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: () => loadEnv(),
    }),
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
            // Redactor PII (rules securite + photos-rgpd + stripe + PRD-001 §4.3 + PRD-002 §4 + PRD-003 Ticket 3.1)
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                // PRD-003 : signature Stripe = secret HMAC, jamais en logs
                'req.headers["stripe-signature"]',
                'req.headers["idempotency-key"]',
                'req.body.password',
                'req.body.passwordHash',
                'req.body.refreshToken',
                'req.body.accessToken',
                'req.body.cardNumber',
                'req.body.cvv',
                // PRD-002 : adresse complète interdite avant ACCEPT (logs / responses)
                'req.body.address.street',
                'req.body.address.location',
                'res.headers["set-cookie"]',
                '*.password',
                '*.passwordHash',
                '*.accessToken',
                '*.refreshToken',
                '*.tokenHash',
                '*.email',
                '*.street',
                '*.location.lat',
                '*.location.lng',
                // PRD-003 Stripe : aucun secret / token Stripe en logs (ADR-008 + rule stripe)
                '*.client_secret',
                '*.clientSecret',
                '*.stripeAccountId',
                '*.stripeCustomerId',
                '*.payment_method',
                '*.paymentMethod',
                '*.card.number',
                '*.bankAccount',
                '*.cardNumber',
                '*.cvv',
                // PRD-003 photos : captureClientUuid = clé idempotence privée + coords GPS
                '*.captureClientUuid',
                '*.gpsLat',
                '*.gpsLng',
                '*.gps.lat',
                '*.gps.lng',
                // PRD-003 Ticket 3.3 — secrets Cloudinary upload session.
                '*.sessionToken',
                '*.tokenDigest',
                '*.cloudinaryParams.signature',
                '*.cloudinaryParams.api_key',
                '*.signature',
                '*.api_secret',
              ],
              censor: '[REDACTED]',
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
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MissionsModule,
    /**
     * PRD-003 Ticket 3.1 — module Payments gated par `FF_PAYMENTS_ENABLED`.
     * Le module se charge toujours (Nest a besoin du graph statique), mais les
     * controllers / processors sont neutralisés si le flag est `false`
     * (cf. `PaymentsModule.register()`).
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
     * Cycle forwardRef avec `PaymentsModule` (PaymentDomainHandler appelle
     * `AutoReleaseService.cancel`, `MissionCompletionService.validate`
     * appelle `PaymentsService.requestCapture`).
     */
    MissionsCompletionModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ConditionalThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
