/**
 * Schémas Zod — authentification (PRD-001).
 * Alignés sur les DTO HTTP NestJS + nestjs-zod (Ticket 1.3).
 */

import { z } from 'zod'

import { AUTH_PASSWORD_BLOCKLIST } from './auth-weak-blocklist'
import { emailSchema, passwordSchema, uuidSchema } from './primitives'
import { RoleSchema } from './enums'

/** Rôle autorisé au signup public (ADMIN exclu — AC-1.5). */
export const authSignUpPublicRoleSchema = z.enum(['CLIENT', 'PRESTATAIRE'])
export type AuthSignUpPublicRole = z.infer<typeof authSignUpPublicRoleSchema>

export const authSignUpRequestBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    role: authSignUpPublicRoleSchema,
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine((data, ctx) => {
    const lower = data.password.toLowerCase()
    if (AUTH_PASSWORD_BLOCKLIST.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WEAK_PASSWORD',
        path: ['password'],
      })
    }
  })

export type AuthSignUpRequestBody = z.infer<typeof authSignUpRequestBodySchema>

export const authLoginRequestBodySchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict()

export type AuthLoginRequestBody = z.infer<typeof authLoginRequestBodySchema>

export const authRefreshRequestBodySchema = z
  .object({
    refreshToken: z.string().min(1).max(512),
  })
  .strict()

export type AuthRefreshRequestBody = z.infer<typeof authRefreshRequestBodySchema>

export const authLogoutRequestBodySchema = authRefreshRequestBodySchema
export type AuthLogoutRequestBody = z.infer<typeof authLogoutRequestBodySchema>

/** Utilisateur exposé aux clients (sans secrets). */
export const authUserPublicSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  role: RoleSchema,
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  createdAt: z.string().datetime({ offset: true }),
})

export type AuthUserPublic = z.infer<typeof authUserPublicSchema>

export const authTokensPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
})

export type AuthTokensPair = z.infer<typeof authTokensPairSchema>

/** Réponse signup / login : même enveloppe (profil complet + paire de tokens). */
export const authSessionResponseSchema = z.object({
  user: authUserPublicSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
})

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>

export const authSignUpResponseSchema = authSessionResponseSchema
export type AuthSignUpResponse = z.infer<typeof authSignUpResponseSchema>

export const authLoginResponseSchema = authSessionResponseSchema
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>

export const authRefreshResponseSchema = authTokensPairSchema
export type AuthRefreshResponse = z.infer<typeof authRefreshResponseSchema>

export const authMeResponseSchema = authUserPublicSchema
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>

/** Erreurs métier stables (codes machine côté client). */
export const authErrorCodeSchema = z.enum([
  'EMAIL_ALREADY_USED',
  'INVALID_CREDENTIALS',
  'INVALID_REFRESH_TOKEN',
  'WEAK_PASSWORD',
  'ADMIN_SIGNUP_FORBIDDEN',
])

export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>

export const authErrorResponseSchema = z.object({
  error: authErrorCodeSchema,
  reason: z.string().max(500).optional(),
})

export type AuthErrorResponse = z.infer<typeof authErrorResponseSchema>
