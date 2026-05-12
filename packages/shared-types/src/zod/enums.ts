/**
 * Enums partagés — **réexportés depuis** `zod-prisma-types` (`./generated/inputTypeSchemas/*`).
 *
 * Source de vérité unique : `apps/api/prisma/schema.prisma`.
 * Imports **fichier par fichier** (pas le barrel `index.ts`) pour éviter de tirer
 * les schémas Prisma JSON auxquels `tsc` strict reproche des incompatibilités Zod.
 */

import { z } from 'zod'

import { AutoReleaseJobStatusSchema } from './generated/inputTypeSchemas/AutoReleaseJobStatusSchema'
import { MissionServiceTypeSchema } from './generated/inputTypeSchemas/MissionServiceTypeSchema'
import { MissionStatusSchema } from './generated/inputTypeSchemas/MissionStatusSchema'
import { PaymentStatusSchema } from './generated/inputTypeSchemas/PaymentStatusSchema'
import { PhotoDeletionActorSchema } from './generated/inputTypeSchemas/PhotoDeletionActorSchema'
import { PhotoDeletionReasonSchema } from './generated/inputTypeSchemas/PhotoDeletionReasonSchema'
import { PhotoTypeSchema } from './generated/inputTypeSchemas/PhotoTypeSchema'
import { PhotoVariantSchema } from './generated/inputTypeSchemas/PhotoVariantSchema'
import { ProviderPayoutStatusSchema } from './generated/inputTypeSchemas/ProviderPayoutStatusSchema'
import { RoleSchema } from './generated/inputTypeSchemas/RoleSchema'
import { StripeWebhookProcessingStatusSchema } from './generated/inputTypeSchemas/StripeWebhookProcessingStatusSchema'
import { TransferStatusSchema } from './generated/inputTypeSchemas/TransferStatusSchema'
import { WebhookDeadLetterSourceSchema } from './generated/inputTypeSchemas/WebhookDeadLetterSourceSchema'

export {
  AutoReleaseJobStatusSchema,
  MissionServiceTypeSchema,
  MissionStatusSchema,
  PaymentStatusSchema,
  PhotoDeletionActorSchema,
  PhotoDeletionReasonSchema,
  PhotoTypeSchema,
  PhotoVariantSchema,
  ProviderPayoutStatusSchema,
  RoleSchema,
  StripeWebhookProcessingStatusSchema,
  TransferStatusSchema,
  WebhookDeadLetterSourceSchema,
}

export type AutoReleaseJobStatus = z.infer<typeof AutoReleaseJobStatusSchema>
export type MissionServiceType = z.infer<typeof MissionServiceTypeSchema>
export type MissionStatus = z.infer<typeof MissionStatusSchema>
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>
export type PhotoDeletionActor = z.infer<typeof PhotoDeletionActorSchema>
export type PhotoDeletionReason = z.infer<typeof PhotoDeletionReasonSchema>
export type PhotoType = z.infer<typeof PhotoTypeSchema>
export type PhotoVariant = z.infer<typeof PhotoVariantSchema>
export type ProviderPayoutStatus = z.infer<typeof ProviderPayoutStatusSchema>
export type Role = z.infer<typeof RoleSchema>
export type StripeWebhookProcessingStatus = z.infer<typeof StripeWebhookProcessingStatusSchema>
export type TransferStatus = z.infer<typeof TransferStatusSchema>
export type WebhookDeadLetterSource = z.infer<typeof WebhookDeadLetterSourceSchema>
