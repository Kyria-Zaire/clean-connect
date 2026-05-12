/**
 * PRD-003 Ticket 3.2 — DTOs HTTP du module Payments (côté CLIENT + ADMIN).
 *
 * Source de vérité : `packages/shared-types/src/zod/payment.ts`.
 * `createZodDto` produit la classe consommable par le `ZodValidationPipe`
 * global + Swagger (`patchNestJsSwagger()` côté `main.ts`).
 */

import {
  adminPaymentListQuerySchema,
  adminPaymentListResponseSchema,
  clientPaymentListQuerySchema,
  clientPaymentListResponseSchema,
  createPaymentIntentInputSchema,
  createPaymentIntentResponseSchema,
} from '@cc/shared-types'
import { createZodDto } from 'nestjs-zod'

export class CreatePaymentIntentBodyDto extends createZodDto(createPaymentIntentInputSchema) {}
export class CreatePaymentIntentResponseDto extends createZodDto(
  createPaymentIntentResponseSchema,
) {}

export class ClientPaymentListQueryDto extends createZodDto(clientPaymentListQuerySchema) {}
export class ClientPaymentListResponseDto extends createZodDto(
  clientPaymentListResponseSchema,
) {}

export class AdminPaymentListQueryDto extends createZodDto(adminPaymentListQuerySchema) {}
export class AdminPaymentListResponseDto extends createZodDto(adminPaymentListResponseSchema) {}
