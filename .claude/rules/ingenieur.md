
# Ingénieur Fullstack — Bootstrap NestJS

> Activé sur le bootstrap serveur (`main.ts`, `app.module.ts`, `common/`, `config/`).
> Garant de la qualité globale : ordre d'initialisation, validation env, exception filter.

---

## main.ts — squelette obligatoire

```typescript
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { env } from './config/env'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter'
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,   // requis pour Stripe webhooks
  })

  app.useLogger(app.get(Logger))

  app.use(helmet())
  app.enableCors({
    origin: env.CORS_ORIGINS.split(','),
    credentials: true,
  })

  app.setGlobalPrefix('api')

  app.useGlobalPipes(new ZodValidationPipe())
  app.useGlobalFilters(new AllExceptionsFilter())

  app.enableShutdownHooks()

  await app.listen(env.PORT)
}

bootstrap()
```

**Règles** :
- `rawBody: true` est **obligatoire** (Stripe vérifie la signature sur le body brut)
- `setGlobalPrefix('api')` pour tout préfixer
- `enableShutdownHooks()` pour fermer proprement Prisma + Redis + BullMQ

---

## Validation des variables d'environnement

```typescript
// config/env.ts
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'recette', 'preprod', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CORS_ORIGINS: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  FCM_PROJECT_ID: z.string().min(1),
  FCM_PRIVATE_KEY: z.string().min(1),
  FCM_CLIENT_EMAIL: z.string().email(),

  SENTRY_DSN: z.string().url().optional(),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Invalid env:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
```

**Règle dure** : si une variable manque, le serveur **crash au boot**, jamais à la première requête.

---

## Cohérence environnement Stripe ↔ DB

```typescript
// Vérifié au démarrage
const isLiveStripe = env.STRIPE_SECRET_KEY.startsWith('sk_live_')
const isProdEnv = env.NODE_ENV === 'production'

if (isLiveStripe !== isProdEnv) {
  console.error('❌ Stripe key / NODE_ENV mismatch. Refusing to start.')
  process.exit(1)
}
```

Empêche un déploiement où la prod tape Stripe test, ou inversement.

---

## Exception filter centralisé

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger() private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<Request>()

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR

    const message = exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error'

    if (status >= 500) {
      this.logger.error({ err: exception, path: req.url, method: req.method }, 'Server error')
    } else {
      this.logger.warn({ status, path: req.url, method: req.method }, 'Client error')
    }

    res.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: req.url,
    })
  }
}
```

---

## Health check

```typescript
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('escrow') private readonly escrowQueue: Queue,
  ) {}

  @Get()
  async check() {
    const checks = {
      status: 'ok' as 'ok' | 'degraded',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      services: {
        database: 'unknown' as 'ok' | 'error',
        redis: 'unknown' as 'ok' | 'error',
      },
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`
      checks.services.database = 'ok'
    } catch {
      checks.services.database = 'error'
      checks.status = 'degraded'
    }

    try {
      await this.escrowQueue.client.ping()
      checks.services.redis = 'ok'
    } catch {
      checks.services.redis = 'error'
      checks.status = 'degraded'
    }

    return { ...checks, httpStatus: checks.status === 'ok' ? 200 : 503 }
  }
}
```

Endpoint public (pas de guard) mais sans détails sensibles.

---

## PrismaService

```typescript
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
```

---

## Interdictions

- `process.env.X` lu à la volée dans le code métier → toujours `env.X` depuis `config/env.ts`
- Logger custom ad-hoc → toujours `@InjectPinoLogger` ou `nestjs-pino`
- Connexion DB sans pool → Prisma gère, ne pas instancier de Pool manuel
- `app.useGlobalPipes(new ValidationPipe())` (class-validator) → on est sur Zod uniquement
