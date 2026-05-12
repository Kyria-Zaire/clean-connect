/**
 * Génération du `missionNumber` lisible (ex. `CC-2026-000123`).
 *
 * Contrainte CTO Build §2 : immuable, unique, généré côté serveur uniquement.
 *
 * Stratégie MVP : numéro = `CC-${année courante}-${suffixeBase36(uuid)}`.
 *  - Pas de séquence DB partagée (évite point de contention global).
 *  - 8 caractères base36 sur 6 octets aléatoires ⇒ collision astronomique.
 *  - L'unicité finale est garantie par la contrainte UNIQUE sur la colonne
 *    `missions.mission_number` (retry au niveau service en cas de P2002).
 *
 * Format réservé "CC-YYYY-XXXXXXXX" (≤ 20 chars, < 32 du `VARCHAR(32)` Prisma).
 */

import { randomBytes } from 'node:crypto'

import { Injectable } from '@nestjs/common'

@Injectable()
export class MissionNumberService {
  generate(): string {
    const year = new Date().getUTCFullYear()
    const suffix = randomBytes(6).readUIntBE(0, 6).toString(36).toUpperCase().padStart(8, '0').slice(-8)
    return `CC-${year}-${suffix}`
  }
}
