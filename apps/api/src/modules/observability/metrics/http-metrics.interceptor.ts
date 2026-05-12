/**
 * HttpMetricsInterceptor (PRD-004 Ticket 4.1 — Build A3).
 *
 * Émet pour chaque requête HTTP traitée par Nest :
 * - `cleanconnect_http_requests_total{method,route,status}` (counter)
 * - `cleanconnect_http_request_duration_seconds{method,route,status}` (histogram)
 *
 * **Cardinalité contrôlée** :
 * - `method` ∈ {GET, POST, PATCH, DELETE, OPTIONS, HEAD, PUT}
 * - `route` = **pattern Express normalisé** (`/api/v1/payments/:id`),
 *   jamais l'URL réelle. Si la requête n'a pas matché de handler Nest
 *   (404 sans route), on label `__unmatched__` pour cap la cardinalité.
 * - `status` = `200`, `400`, `500`, etc. (50 values max).
 *
 * Aucune PII / UUID / token n'apparaît dans les labels — règle dure A3
 * (ADR-014 §2.6).
 */

import {
  CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { type Observable, tap } from 'rxjs'

import { MetricsService } from './metrics.service'
import { normalizeRoute } from './route-normalizer'

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()

    const req = context.switchToHttp().getRequest<Request>()
    const res = context.switchToHttp().getResponse<Response>()
    const method = req.method
    const start = process.hrtime.bigint()

    return next.handle().pipe(
      tap({
        next: () => this.record(method, req, res, start),
        error: () => this.record(method, req, res, start),
      }),
    )
  }

  private record(method: string, req: Request, res: Response, start: bigint): void {
    const route = normalizeRoute(req)
    const status = String(res.statusCode || 0)
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9

    this.metrics.httpRequestsTotal.inc({ method, route, status })
    this.metrics.httpRequestDurationSeconds.observe({ method, route, status }, durationSeconds)
  }
}
