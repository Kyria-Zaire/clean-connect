import { Controller, Get } from '@nestjs/common'
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus'
import { ApiTags } from '@nestjs/swagger'

import { PrismaService } from '../../common/prisma/prisma.service'

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
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
    return this.health.check([() => this.prismaHealth.pingCheck('database', this.prisma)])
  }
}
