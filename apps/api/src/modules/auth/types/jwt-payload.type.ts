import type { Role } from '@prisma/client'

/**
 * Payload minimal porté par l'access JWT (AC-6.5 + PRD §3.3 Q8/Q9).
 * - `sub`  → userId
 * - `role` → autorisation côté RolesGuard sans round-trip DB
 * - `jti`  → identifiant unique du token (audit, invalidation future)
 * - `iat` / `exp` → standard JWT (epoch seconds)
 */
export interface JwtAccessPayload {
  sub: string
  role: Role
  jti: string
  iat: number
  exp: number
}

/**
 * Utilisateur attaché à `request.user` après passage du JwtAccessGuard.
 * On garde le strict nécessaire pour les guards/decorators ; les détails
 * profil sont chargés explicitement via `/auth/me` (source de vérité front).
 */
export interface AuthenticatedUser {
  id: string
  role: Role
  jti: string
}
