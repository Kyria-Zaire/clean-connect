-- PRD-003 Ticket 3.2 — Payment lifecycle + PaymentIntent manual capture.
--
-- Ajouts :
--   1. MissionStatus.PENDING_PAYMENT (état intermédiaire DRAFT → PUBLISHED).
--   2. PaymentStatus.AUTHORIZATION_PENDING (état initial Payment, avant webhook autorisation).
--   3. Payment.idempotency_key (header client, dédup HTTP + idempotence Stripe).
--   4. Payment.failure_code / failure_message (renseignés par webhook payment_failed / canceled).
--
-- Rule stripe + ADR-008 : aucune transition Mission DRAFT → PUBLISHED autorisée
-- côté API (gated FF) — la publication passe désormais par PENDING_PAYMENT puis
-- webhook Stripe (`payment_intent.amount_capturable_updated`).

-- 1. MissionStatus.PENDING_PAYMENT
ALTER TYPE "MissionStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT' BEFORE 'PUBLISHED';

-- 2. PaymentStatus.AUTHORIZATION_PENDING (avant AUTHORIZED)
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'AUTHORIZATION_PENDING' BEFORE 'AUTHORIZED';

-- 3. Payment.idempotency_key + 4. failure_code / failure_message
-- Note : la colonne `idempotency_key` est `NOT NULL` car aucune ligne `payments`
-- ne peut exister en MVP sans clé (la table est encore vide en dev/recette/preprod).
ALTER TABLE "payments"
  ADD COLUMN "idempotency_key" VARCHAR(255) NOT NULL,
  ADD COLUMN "failure_code"    VARCHAR(120),
  ADD COLUMN "failure_message" TEXT;

CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");
