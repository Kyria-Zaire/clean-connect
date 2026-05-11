import { Controller, Get } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'

import { PrismaService } from '../../common/prisma/prisma.service'

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('healthz')
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([])
  }

  @Get('readyz')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      async () => {
        // Health check Prisma manuel (terminus.PrismaHealthIndicator a un mismatch
        // de types avec @prisma/client, cf. Nest issue connue). $queryRaw SELECT 1
        // est l'équivalent fonctionnel et stable.
        const start = Date.now()
        try {
          await this.prisma.$queryRaw`SELECT 1`
          return { database: { status: 'up', responseTimeMs: Date.now() - start } }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown'
          return { database: { status: 'down', message } }
        }
      },
    ])
  }
}
