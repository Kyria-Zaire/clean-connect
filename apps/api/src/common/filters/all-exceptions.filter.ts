import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { Logger as PinoLogger } from 'nestjs-pino'
import { ZodValidationException } from 'nestjs-zod'

interface ErrorResponseBody {
  statusCode: number
  error: string
  message: string | string[]
  path: string
  timestamp: string
  // Détails métier optionnels (ex: `reason: 'mission_expired'`).
  // Non typés car spécifiques à chaque domaine (mission, payment, …).
  [extra: string]: unknown
}

/**
 * Champs réservés à la forme principale — ne doivent pas être écrasés par
 * un détail métier additionnel (`getResponse()` peut contenir n'importe
 * quoi, on whiteliste pour éviter une fuite ou une collision).
 */
const RESERVED_FIELDS = new Set([
  'statusCode',
  'error',
  'message',
  'path',
  'timestamp',
])

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const req = ctx.getRequest<Request>()
    const res = ctx.getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let error = 'Internal Server Error'
    let message: string | string[] = 'Une erreur est survenue.'
    const extra: Record<string, unknown> = {}

    if (exception instanceof ZodValidationException) {
      status = HttpStatus.BAD_REQUEST
      error = 'ValidationError'
      message = exception.getZodError().issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'string') {
        message = body
      } else if (typeof body === 'object' && body !== null) {
        const bodyObj = body as { message?: string | string[]; error?: string } & Record<string, unknown>
        message = bodyObj.message ?? message
        error = bodyObj.error ?? exception.name
        // Récupère les détails métier additionnels (ex: `reason`) sans
        // jamais écraser les champs principaux ni laisser fuiter des trucs
        // techniques (`statusCode` Nest interne).
        for (const [key, value] of Object.entries(bodyObj)) {
          if (RESERVED_FIELDS.has(key)) continue
          if (key === 'message' || key === 'error') continue
          extra[key] = value
        }
      } else {
        error = exception.name
      }
    } else if (exception instanceof Error) {
      this.logger.error({ err: exception }, 'Unhandled exception')
    }

    const responseBody: ErrorResponseBody = {
      statusCode: status,
      error,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
      ...extra,
    }

    res.status(status).json(responseBody)
  }
}
