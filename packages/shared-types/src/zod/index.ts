/**
 * Point d'entrée des schémas Zod partagés.
 *
 * Architecture :
 *   - `enums.ts`         → réexport ciblé des enums Prisma (`./generated/inputTypeSchemas/*Schema.ts`)
 *   - `primitives.ts`    → schémas réutilisables (uuid, email, geoPoint, money, sha256)
 *   - `idempotency.ts`   → Idempotency-Key partagé (PRD-003)
 *   - `auth.ts`          → DTOs auth (PRD-001)
 *   - `mission.ts`       → DTOs missions (PRD-002)
 *   - `payment.ts`       → DTOs Payment + Transfer (PRD-003) — Input/Internal/Public/RBAC
 *   - `photo.ts`         → DTOs Photo + PhotoUploadSession + PhotoDeletionLog (PRD-003)
 *   - `webhook.ts`       → 3 niveaux (Stripe raw / Internal / Domain event) (PRD-003)
 *   - `auto-release.ts`  → AutoReleaseJob (PRD-003)
 *   - `generated/*.ts`   → schémas générés par zod-prisma-types (un fichier par modèle)
 *
 * Référence : ADR-002 (montants), ADR-003 (PostGIS), ADR-008/009/010/011 (à venir Sprint 3).
 */

export * from './enums'
export * from './primitives'
export * from './idempotency'
export * from './auth'
export * from './mission'
export * from './payment'
export * from './photo'
export * from './webhook'
export * from './auto-release'
