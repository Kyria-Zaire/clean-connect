/**
 * Tests Zod — PRD-003 livrable 2/5 (Design).
 *
 * Vérifient les règles métier piégeuses :
 *   1. `idempotencyKeySchema` — charset / pas de trim implicite / min-max.
 *   2. `moneyCentsSchema` / `moneyCentsPositiveSchema` — int, ≥0, plafond 50 000 €.
 *   3. `photoGpsInputSchema` — lat/lng co-présents ou tous NULL.
 *   4. `paymentMonetarySnapshotInternalSchema` — checks consistency.
 *   5. `domainEventSchema` — discriminated union par `kind`.
 *   6. `presignPhotoUploadInputSchema` — MIME whitelist + maxBytes.
 *   7. `stripeWebhookRawSchema` — `evt_` prefix.
 *   8. Public schemas ne contiennent pas les champs interdits (token_digest,
 *      checksum, transferGroup) — vérif syntaxique via `.strict()`.
 */

import {
  IDEMPOTENCY_KEY_REGEX,
  PHOTO_ALLOWED_MIME_TYPES,
  PHOTO_MAX_BYTES,
  adminPhotoViewSchema,
  adminTransferViewSchema,
  clientPaymentViewSchema,
  domainEventSchema,
  idempotencyKeySchema,
  moneyCentsPositiveSchema,
  moneyCentsSchema,
  paymentMonetarySnapshotInternalSchema,
  photoGpsInputSchema,
  prestatairePaymentViewSchema,
  presignPhotoUploadInputSchema,
  publicPhotoSchema,
  serverIdempotencyKeySchema,
  stripeWebhookRawSchema,
} from '@cc/shared-types/zod'

describe('PRD-003 Zod — règles métier critiques', () => {
  // -----------------------------------------------------------------------
  // 1. IdempotencyKey
  // -----------------------------------------------------------------------
  describe('idempotencyKeySchema', () => {
    it('accepte une clé valide [A-Za-z0-9_-]', () => {
      expect(idempotencyKeySchema.parse('cc-abc-123_XYZ-456789')).toBe('cc-abc-123_XYZ-456789')
    })

    it('refuse les caractères hors charset (espace, accent, symbole)', () => {
      expect(() => idempotencyKeySchema.parse('cc-abc 123')).toThrow()
      expect(() => idempotencyKeySchema.parse('cc-éàç-123')).toThrow()
      expect(() => idempotencyKeySchema.parse('cc-abc!123')).toThrow()
    })

    it('refuse < 8 ou > 255 caractères', () => {
      expect(() => idempotencyKeySchema.parse('short')).toThrow()
      expect(() => idempotencyKeySchema.parse('a'.repeat(256))).toThrow()
    })

    it('ne trim PAS (espace en début/fin = invalide via charset)', () => {
      // CTO : trim interdit (sinon "  abc  " et "abc" deviendraient équivalents).
      expect(() => idempotencyKeySchema.parse('  cc-abc-123  ')).toThrow()
    })

    it('la regex partagée IDEMPOTENCY_KEY_REGEX est cohérente', () => {
      expect(IDEMPOTENCY_KEY_REGEX.test('cc-abc-123')).toBe(true)
      expect(IDEMPOTENCY_KEY_REGEX.test('cc abc 123')).toBe(false)
    })

    it('serverIdempotencyKeySchema exige un préfixe métier', () => {
      expect(serverIdempotencyKeySchema.parse('transfer-mission-abc12345')).toBe(
        'transfer-mission-abc12345',
      )
      expect(serverIdempotencyKeySchema.parse('capture-mission-xyz98765')).toBe(
        'capture-mission-xyz98765',
      )
      expect(() => serverIdempotencyKeySchema.parse('random-key-12345678')).toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // 2. Money strict
  // -----------------------------------------------------------------------
  describe('moneyCentsSchema / moneyCentsPositiveSchema', () => {
    it('accepte un entier ≥ 0 et ≤ 50 000 €', () => {
      expect(moneyCentsSchema.parse(0)).toBe(0)
      expect(moneyCentsSchema.parse(199_99)).toBe(199_99)
      expect(moneyCentsSchema.parse(50_000_00)).toBe(50_000_00)
    })

    it('refuse les flottants', () => {
      expect(() => moneyCentsSchema.parse(199.99)).toThrow()
      expect(() => moneyCentsSchema.parse(0.5)).toThrow()
    })

    it('refuse les négatifs', () => {
      expect(() => moneyCentsSchema.parse(-1)).toThrow()
    })

    it('refuse au-delà du plafond', () => {
      expect(() => moneyCentsSchema.parse(50_000_01)).toThrow()
    })

    it('moneyCentsPositiveSchema refuse 0', () => {
      expect(() => moneyCentsPositiveSchema.parse(0)).toThrow()
      expect(moneyCentsPositiveSchema.parse(1)).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // 3. Photo GPS coherence
  // -----------------------------------------------------------------------
  describe('photoGpsInputSchema — lat/lng co-présents', () => {
    it('accepte lat + lng tous deux renseignés', () => {
      expect(() =>
        photoGpsInputSchema.parse({
          gpsLatitude: 48.8566,
          gpsLongitude: 2.3522,
          gpsAccuracyMeters: 10,
        }),
      ).not.toThrow()
    })

    it('accepte lat + lng tous deux NULL', () => {
      expect(() =>
        photoGpsInputSchema.parse({
          gpsLatitude: null,
          gpsLongitude: null,
        }),
      ).not.toThrow()
    })

    it('refuse lat sans lng', () => {
      expect(() =>
        photoGpsInputSchema.parse({
          gpsLatitude: 48.8566,
          gpsLongitude: null,
        }),
      ).toThrow()
    })

    it('refuse lng sans lat', () => {
      expect(() =>
        photoGpsInputSchema.parse({
          gpsLatitude: null,
          gpsLongitude: 2.3522,
        }),
      ).toThrow()
    })

    it('refuse accuracy renseigné quand lat/lng sont NULL', () => {
      expect(() =>
        photoGpsInputSchema.parse({
          gpsLatitude: null,
          gpsLongitude: null,
          gpsAccuracyMeters: 10,
        }),
      ).toThrow()
    })

    it('refuse lat hors borne (>90)', () => {
      expect(() =>
        photoGpsInputSchema.parse({ gpsLatitude: 91, gpsLongitude: 0 }),
      ).toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // 4. Payment snapshots consistency
  // -----------------------------------------------------------------------
  describe('paymentMonetarySnapshotInternalSchema', () => {
    const base = {
      amountAuthorizedCents: 200_00,
      amountCapturedCents: null,
      applicationFeeCents: null,
      providerPayoutCents: null,
      currency: 'eur' as const,
      vatRateSnapshot: null,
    }

    it('accepte le snapshot initial (tout NULL)', () => {
      expect(() => paymentMonetarySnapshotInternalSchema.parse(base)).not.toThrow()
    })

    it('refuse captured > authorized', () => {
      expect(() =>
        paymentMonetarySnapshotInternalSchema.parse({
          ...base,
          amountCapturedCents: 201_00,
        }),
      ).toThrow()
    })

    it('refuse application_fee > authorized', () => {
      expect(() =>
        paymentMonetarySnapshotInternalSchema.parse({
          ...base,
          applicationFeeCents: 201_00,
          providerPayoutCents: -1_00, // pour passer le check de cohérence
        }),
      ).toThrow()
    })

    it('refuse provider_payout incohérent avec authorized - fee', () => {
      expect(() =>
        paymentMonetarySnapshotInternalSchema.parse({
          ...base,
          applicationFeeCents: 36_00, // 18 %
          providerPayoutCents: 200_00, // devrait être 164_00
        }),
      ).toThrow()
    })

    it('accepte un snapshot cohérent (200 € - 36 € = 164 €)', () => {
      expect(() =>
        paymentMonetarySnapshotInternalSchema.parse({
          ...base,
          amountCapturedCents: 200_00,
          applicationFeeCents: 36_00,
          providerPayoutCents: 164_00,
        }),
      ).not.toThrow()
    })

    it('refuse fee sans payout (ou inverse)', () => {
      expect(() =>
        paymentMonetarySnapshotInternalSchema.parse({
          ...base,
          applicationFeeCents: 36_00,
          providerPayoutCents: null,
        }),
      ).toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // 5. Domain event discriminated union
  // -----------------------------------------------------------------------
  describe('domainEventSchema', () => {
    it('discrimine par `kind` — PaymentCaptured', () => {
      const evt = {
        kind: 'PaymentCaptured' as const,
        sourceEventId: 'evt_abc123',
        occurredAt: '2026-05-12T10:00:00.000Z',
        paymentId: '11111111-1111-4111-8111-111111111111',
        missionId: '22222222-2222-4222-8222-222222222222',
        amountCapturedCents: 200_00,
      }
      expect(() => domainEventSchema.parse(evt)).not.toThrow()
    })

    it('refuse un `kind` inconnu', () => {
      expect(() =>
        domainEventSchema.parse({
          kind: 'PaymentUnknown',
          sourceEventId: 'evt_abc',
          occurredAt: '2026-05-12T10:00:00.000Z',
        }),
      ).toThrow()
    })

    it('refuse un payload mal formé pour le kind correct', () => {
      expect(() =>
        domainEventSchema.parse({
          kind: 'TransferSent',
          sourceEventId: 'evt_abc',
          occurredAt: '2026-05-12T10:00:00.000Z',
          // manque transferId, paymentId, etc.
        }),
      ).toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // 6. Presign photo upload
  // -----------------------------------------------------------------------
  describe('presignPhotoUploadInputSchema', () => {
    const valid = {
      missionId: '11111111-1111-4111-8111-111111111111',
      phase: 'BEFORE' as const,
      variant: 'DISPLAY' as const,
      captureClientUuid: '22222222-2222-4222-8222-222222222222',
      bytes: 250_000,
      mimeType: 'image/jpeg' as const,
      gps: {
        gpsLatitude: 48.8566,
        gpsLongitude: 2.3522,
        gpsAccuracyMeters: 12,
      },
    }

    it('accepte un payload valide', () => {
      expect(() => presignPhotoUploadInputSchema.parse(valid)).not.toThrow()
    })

    it('refuse mimeType hors whitelist', () => {
      expect(() =>
        presignPhotoUploadInputSchema.parse({ ...valid, mimeType: 'image/tiff' }),
      ).toThrow()
    })

    it('expose la whitelist MIME en constante', () => {
      expect(PHOTO_ALLOWED_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/heic', 'image/webp'])
    })

    it('refuse bytes > 10 Mo', () => {
      expect(() =>
        presignPhotoUploadInputSchema.parse({ ...valid, bytes: PHOTO_MAX_BYTES + 1 }),
      ).toThrow()
    })

    it('refuse captureClientUuid absent', () => {
      const partial: Record<string, unknown> = { ...valid }
      delete partial.captureClientUuid
      expect(() => presignPhotoUploadInputSchema.parse(partial)).toThrow()
    })

    it('refuse champ inconnu (.strict)', () => {
      expect(() =>
        presignPhotoUploadInputSchema.parse({ ...valid, unknownField: 'foo' }),
      ).toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // 7. Stripe webhook raw — evt_ prefix
  // -----------------------------------------------------------------------
  describe('stripeWebhookRawSchema', () => {
    const base = {
      id: 'evt_abc123',
      object: 'event' as const,
      type: 'payment_intent.succeeded' as const,
      livemode: false,
      api_version: '2025-02-24.acacia',
      created: 1_715_000_000,
      data: { object: { id: 'pi_abc' } },
      request: { id: null, idempotency_key: null },
      pending_webhooks: 1,
    }

    it('accepte un raw event correct', () => {
      expect(() => stripeWebhookRawSchema.parse(base)).not.toThrow()
    })

    it('refuse un id sans préfixe `evt_`', () => {
      expect(() => stripeWebhookRawSchema.parse({ ...base, id: 'pi_abc123' })).toThrow()
    })

    it('refuse un type non whitelisté', () => {
      expect(() =>
        stripeWebhookRawSchema.parse({ ...base, type: 'invoice.payment_succeeded' }),
      ).toThrow()
    })

    it('tolère des champs additionnels Stripe (passthrough)', () => {
      const parsed = stripeWebhookRawSchema.parse({ ...base, account: 'acct_123' })
      expect(parsed.id).toBe('evt_abc123')
    })
  })

  // -----------------------------------------------------------------------
  // 8. Vues publiques RBAC — vérification "no leak"
  // -----------------------------------------------------------------------
  describe('Public schemas n\'exposent pas les champs interdits', () => {
    it('clientPaymentViewSchema n\'a pas applicationFeeCents/providerPayoutCents/vatRateSnapshot', () => {
      const shape = clientPaymentViewSchema.shape
      expect(shape).not.toHaveProperty('applicationFeeCents')
      expect(shape).not.toHaveProperty('providerPayoutCents')
      expect(shape).not.toHaveProperty('vatRateSnapshot')
      expect(shape).not.toHaveProperty('clientSecret')
    })

    it('prestatairePaymentViewSchema n\'a pas applicationFeeCents ni stripePaymentIntentId', () => {
      const shape = prestatairePaymentViewSchema.shape
      expect(shape).not.toHaveProperty('applicationFeeCents')
      expect(shape).not.toHaveProperty('stripePaymentIntentId')
      expect(shape).not.toHaveProperty('amountAuthorizedCents')
      expect(shape).toHaveProperty('providerPayoutCents')
    })

    it('publicPhotoSchema n\'a pas cloudinaryPublicId, checksum, tokenDigest, flagSuspicious', () => {
      const shape = publicPhotoSchema.shape
      expect(shape).not.toHaveProperty('cloudinaryPublicId')
      expect(shape).not.toHaveProperty('checksumSha256')
      expect(shape).not.toHaveProperty('tokenDigest')
      expect(shape).not.toHaveProperty('flagSuspicious')
    })

    it('adminPhotoViewSchema expose cloudinaryPublicId + checksum + flagSuspicious', () => {
      const shape = adminPhotoViewSchema.shape
      expect(shape).toHaveProperty('cloudinaryPublicId')
      expect(shape).toHaveProperty('checksumSha256')
      expect(shape).toHaveProperty('flagSuspicious')
    })

    it('adminTransferViewSchema expose retryCount et failureReason (admin only)', () => {
      const shape = adminTransferViewSchema.shape
      expect(shape).toHaveProperty('retryCount')
      expect(shape).toHaveProperty('failureReason')
      expect(shape).not.toHaveProperty('idempotencyKey')
    })
  })
})
