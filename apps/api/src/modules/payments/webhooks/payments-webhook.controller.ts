/**
 * PRD-003 Ticket 3.1 — Controller webhook Stripe (HTTP I/O uniquement).
 *
 * Conformément au cadrage Build : aucune logique métier ici. Toute la pipeline
 * (signature + livemode + insert + enqueue) vit dans `PaymentsWebhookService`.
 *
 * Sécurité :
 * - Endpoint PUBLIC (pas de JWT) — authentifié uniquement par signature Stripe.
 * - Throttler désactivé par `@SkipThrottle()` (la signature HMAC est suffisante,
 *   et Stripe peut burst lors d'un replay legitime — audit Verify V1).
 * - Raw body OBLIGATOIRE — `main.ts` configure `rawBody: true` au boot.
 */

import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { SkipThrottle } from '@nestjs/throttler'
import type { Request } from 'express'

import { Public } from '../../auth/decorators/public.decorator'
import { WebhookPayloadMalformedException } from '../payments.errors'

import { PaymentsWebhookService, type IngestResult } from './payments-webhook.service'

@ApiTags('webhooks')
@Controller({ path: 'webhooks/stripe', version: '1' })
export class PaymentsWebhookController {
  constructor(private readonly service: PaymentsWebhookService) {}

  /**
   * `POST /api/v1/webhooks/stripe` — endpoint Stripe (cf. OpenAPI PRD-003 §Bloc 3).
   *
   * Réponses :
   * - `202` `{ accepted: true, idempotent: boolean, eventId }`
   * - `400` `WEBHOOK_INVALID_SIGNATURE | WEBHOOK_LIVEMODE_MISMATCH | WEBHOOK_PAYLOAD_MALFORMED`
   * - `503` `PAYMENTS_DISABLED` (FF_PAYMENTS_ENABLED=false)
   *
   * Note Build vs OpenAPI Design : sur replay (`P2002` côté DB), on renvoie 202
   * idempotent au lieu de 409 (best practice Stripe pour éviter une boucle de
   * retry 3 jours). Le contrat OpenAPI est ajusté en conséquence dans cette PR
   * (PRD-003 §5.4 — clarification Build acceptée par CTO sur la PR).
   */
  @Public()
  @SkipThrottle()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Endpoint Stripe — events webhook signés HMAC' })
  @ApiResponse({ status: 202, description: 'Event accepté pour traitement async.' })
  @ApiResponse({ status: 400, description: 'Signature / livemode / payload invalides.' })
  @ApiResponse({ status: 503, description: 'PAYMENTS_DISABLED — feature flag off.' })
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<IngestResult> {
    // `main.ts` active `rawBody: true` ; si `rawBody` est manquant ici, l'app
    // est mal configurée (jamais en prod, audit V1 catch).
    if (!req.rawBody) {
      throw new WebhookPayloadMalformedException('missing_raw_body')
    }
    return this.service.ingest(req.rawBody, signature)
  }
}
