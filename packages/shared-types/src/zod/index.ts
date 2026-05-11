/**
 * Point d'entrée des schémas Zod partagés.
 *
 * Architecture cible (à câbler dans les PRDs suivants) :
 *   - `enums.ts`         → enums Prisma (Role, MissionStatus, PhotoType)
 *   - `primitives.ts`    → schémas réutilisables (uuid, email, geoPoint, address)
 *   - `generated/*.ts`   → schémas générés par zod-prisma-types (un fichier par modèle)
 *   - `dto/*.ts`         → DTOs métier (créés au fil des PRDs)
 *
 * Référence : ADR-002 (montants), ADR-003 (PostGIS).
 */

export * from './enums'
export * from './primitives'
export * from './auth'
