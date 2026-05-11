/**
 * DTOs HTTP du module Auth — pilotés par les schémas Zod de `@cc/shared-types`.
 * `createZodDto` produit la classe consommable par `ZodValidationPipe` global
 * et par Swagger (via `patchNestJsSwagger()` appelé dans `main.ts`).
 *
 * Source de vérité : packages/shared-types/src/zod/auth.ts
 */

import {
  authLoginRequestBodySchema,
  authLogoutRequestBodySchema,
  authMeResponseSchema,
  authRefreshRequestBodySchema,
  authRefreshResponseSchema,
  authSessionResponseSchema,
  authSignUpRequestBodySchema,
} from '@cc/shared-types'
import { createZodDto } from 'nestjs-zod'

export class SignUpRequestDto extends createZodDto(authSignUpRequestBodySchema) {}
export class LoginRequestDto extends createZodDto(authLoginRequestBodySchema) {}
export class RefreshRequestDto extends createZodDto(authRefreshRequestBodySchema) {}
export class LogoutRequestDto extends createZodDto(authLogoutRequestBodySchema) {}

export class SessionResponseDto extends createZodDto(authSessionResponseSchema) {}
export class RefreshResponseDto extends createZodDto(authRefreshResponseSchema) {}
export class MeResponseDto extends createZodDto(authMeResponseSchema) {}
