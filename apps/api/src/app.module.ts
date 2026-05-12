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
            // Redactor PII (rules securite + photos-rgpd + PRD-001 §4.3 + PRD-002 §4 CTO Build)
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
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
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    MissionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ConditionalThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
