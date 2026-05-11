import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import helmet from 'helmet'
import { Logger as PinoLogger } from 'nestjs-pino'
import { patchNestJsSwagger } from 'nestjs-zod'

import { AppModule } from './app.module'
import { loadEnv } from './common/config/env'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter'

patchNestJsSwagger()

async function bootstrap() {
  const env = loadEnv()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Body brut requis pour signature webhook Stripe — cf. rule stripe
    rawBody: true,
  })

  app.useLogger(app.get(PinoLogger))

  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  )

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  // NB : pas de `ValidationPipe` (class-validator) global — toutes les routes
  // utilisent des DTOs `createZodDto`, validés par `ZodValidationPipe` enregistré
  // en `APP_PIPE` (cf. app.module.ts). Cumuler les deux faisait rejeter par
  // `forbidNonWhitelisted` un body déjà validé par Zod (bug détecté en Verify
  // PRD-001 Ticket 1.6).

  app.useGlobalFilters(new AllExceptionsFilter(app.get(PinoLogger)))

  if (env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Clean Connect API')
      .setDescription('API backend — NestJS + Prisma + Zod (PRD-001 Auth JWT)')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-jwt')
      .build()
    const document = SwaggerModule.createDocument(app, swaggerConfig)
    SwaggerModule.setup('api-docs', app, document)
  }

  app.enableShutdownHooks()

  await app.listen(env.PORT, '0.0.0.0')

  const logger = app.get(PinoLogger)
  logger.log(`Clean Connect API listening on :${env.PORT} (env=${env.NODE_ENV})`)
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err)
  process.exit(1)
})
