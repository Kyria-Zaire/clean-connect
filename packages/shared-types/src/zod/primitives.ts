/**
 * Schémas Zod primitifs réutilisables (UUID, dates, coordonnées GPS, etc.).
 */

import { z } from 'zod'

export const uuidSchema = z.string().uuid('UUID v4 attendu')
export type UUID = z.infer<typeof uuidSchema>

export const isoDateSchema = z.string().datetime({ offset: true })
export type ISODate = z.infer<typeof isoDateSchema>

export const emailSchema = z.string().email().toLowerCase().trim().max(320)
export type Email = z.infer<typeof emailSchema>

export const passwordSchema = z
  .string()
  .min(12, 'Minimum 12 caractères.')
  .max(128, 'Maximum 128 caractères.')

export const latitudeSchema = z.number().min(-90).max(90)
export const longitudeSchema = z.number().min(-180).max(180)

export const geoPointSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
})
export type GeoPoint = z.infer<typeof geoPointSchema>

export const addressSchema = z.object({
  street: z.string().min(1).max(255),
  city: z.string().min(1).max(120),
  zipCode: z
    .string()
    .regex(/^\d{5}$/u, 'Code postal FR (5 chiffres)')
    .max(10),
  country: z.string().length(2).default('FR'),
  location: geoPointSchema,
})
export type AddressInput = z.infer<typeof addressSchema>
