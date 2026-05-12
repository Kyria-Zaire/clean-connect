/**
 * MetricsController — endpoint Prometheus scrape (PRD-004 Ticket 4.1 — Build A3).
 *
 * `GET /api/internal/metrics` (version-neutral) — protégé par
 * `MetricsBearerGuard`. Format `text/plain; version=0.0.4` (standard
 * Prometheus exposition format).
 *
 * - Ce endpoint est **exclu du throttler global** (`@SkipThrottle()`) car
 *   Prometheus scrape toutes les 15-30 secondes (rythme constant).
 * - Aucune PII dans la réponse — toutes les métriques exposent des labels
 *   bornés (cf. `MetricsService`).
 */

import { Controller, Get, Header, HttpCode, HttpStatus, Res, UseGuards, VERSION_NEUTRAL } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import type { Response } from 'express'

import { MetricsBearerGuard } from './metrics-bearer.guard'
import { MetricsService } from './metrics.service'

@Controller({ path: 'internal/metrics', version: VERSION_NEUTRAL })
@SkipThrottle()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @UseGuards(MetricsBearerGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    const { contentType, body } = await this.metrics.render()
    res.setHeader('Content-Type', contentType)
    return body
  }
}
