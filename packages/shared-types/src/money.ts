/**
 * Helpers monétaires Clean Connect.
 * Référence : ADR-002 (tous les montants en centimes / Int).
 *
 * Règle absolue : aucun composant UI ou service métier ne fait `amount / 100`
 * en dur — tout passe par ces helpers.
 */

import { z } from 'zod'

/** Schéma Zod réutilisable pour un montant en centimes (positif, plafond 50 000 €). */
export const amountCentsSchema = z
  .number()
  .int('Le montant doit être un entier (centimes).')
  .positive('Le montant doit être strictement positif.')
  .max(50_000_00, 'Le montant ne peut pas dépasser 50 000 €.')

export type AmountCents = z.infer<typeof amountCentsSchema>

/** Formate un montant en centimes en chaîne lisible FR. */
export function formatEUR(cents: number, opts?: { withCurrency?: boolean }): string {
  const formatter = new Intl.NumberFormat('fr-FR', {
    style: opts?.withCurrency === false ? 'decimal' : 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return formatter.format(cents / 100)
}

/**
 * Commission Clean Connect.
 * Référence cahier v1.4 §1 : 18 % HT.
 * On stocke en basis points (1 BPS = 0.01 %) pour pouvoir l'ajuster sans toucher au type.
 */
export const COMMISSION_BPS = 1_800 as const // 18.00 %

/** Calcul exact en entiers : floor((amount * bps) / 10000). */
export function commissionCents(amountCents: number, bps: number = COMMISSION_BPS): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`commissionCents: amountCents doit être un entier positif (reçu : ${amountCents})`)
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`commissionCents: bps doit être un entier entre 0 et 10000 (reçu : ${bps})`)
  }
  return Math.floor((amountCents * bps) / 10_000)
}

/** Montant net reversé au prestataire après commission. */
export function payoutCents(amountCents: number, bps: number = COMMISSION_BPS): number {
  return amountCents - commissionCents(amountCents, bps)
}
