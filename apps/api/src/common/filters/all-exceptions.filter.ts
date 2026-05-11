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
}

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
        const bodyObj = body as { message?: string | string[]; error?: string }
        message = bodyObj.message ?? message
        error = bodyObj.error ?? exception.name
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
    }

    res.status(status).json(responseBody)
  }
}
