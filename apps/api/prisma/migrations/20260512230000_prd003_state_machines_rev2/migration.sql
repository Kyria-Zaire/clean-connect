-- =============================================================================
-- Migration : PRD-003 Design rev2 — State Machines (revue CTO 2026-05-12)
--
-- ⚠️  STATUT : Design uniquement. Ne PAS appliquer en main avant sign-off CTO final.
--
-- Ajustements state machines rev2 (revue CTO 2026-05-12 — livrable 4/5 validé sous réserve) :
--   1. PaymentStatus  : + 'CANCELLED'        (AUTHORIZED -> CANCELLED, capture abandonnée / authorization_expired)
--   2. PaymentStatus  : + 'REFUND_PENDING'   (CAPTURED -> REFUND_PENDING -> REFUNDED|FAILED)
--   3. TransferStatus : + 'RETRY_SCHEDULED'  (FAILED -> RETRY_SCHEDULED -> PENDING, retry idempotent)
--   4. AutoReleaseJobStatus : rename 'SUCCEEDED' -> 'COMPLETED' (homogénéité naming terminaux)
--   5. + RefundStatus enum (PENDING / REFUNDED / FAILED) — cycle dédié, **no partial refund MVP**
--   6. + Table `refunds` (lifecycle dédié, idempotency_key UNIQUE, audit acteur)
-- =============================================================================

-- 1. PaymentStatus : nouvelles valeurs (PostgreSQL ALTER TYPE ... ADD VALUE) -------

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- 2. TransferStatus : RETRY_SCHEDULED ----------------------------------------------

ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'RETRY_SCHEDULED';

-- 3. AutoReleaseJobStatus : renommage SUCCEEDED -> COMPLETED -----------------------
-- PostgreSQL supporte `ALTER TYPE ... RENAME VALUE` depuis PG 10.
-- Si la draft précédente n'a pas encore été appliquée, le rename est cosmétique
-- (la valeur 'SUCCEEDED' n'existe pas encore en base prod).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'SUCCEEDED'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AutoReleaseJobStatus')
  ) THEN
    ALTER TYPE "AutoReleaseJobStatus" RENAME VALUE 'SUCCEEDED' TO 'COMPLETED';
  END IF;
END
$$;

-- 4. RefundStatus enum -------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundStatus') THEN
    CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'REFUNDED', 'FAILED');
  END IF;
END
$$;

-- 5. Table refunds -----------------------------------------------------------------
-- Cycle dédié RefundStatus. MVP : refund intégral uniquement (no partial).
-- Idempotency key UNIQUE (déterministe `refund-mission-{missionId}-{attempt}`).

CREATE TABLE IF NOT EXISTS "refunds" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "payment_id"        UUID         NOT NULL,
  "stripe_refund_id"  VARCHAR(255) UNIQUE,
  "idempotency_key"   VARCHAR(255) NOT NULL UNIQUE,
  "amount_cents"      INTEGER      NOT NULL CHECK ("amount_cents" > 0),
  "currency"          VARCHAR(3)   NOT NULL DEFAULT 'eur',
  "status"            "RefundStatus" NOT NULL,
  "reason"            VARCHAR(255),
  "failure_code"      VARCHAR(120),
  "failure_reason"    TEXT,
  "initiated_by"      VARCHAR(64),
  "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "settled_at"        TIMESTAMPTZ,

  CONSTRAINT "refunds_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "refunds_payment_id_status_idx" ON "refunds" ("payment_id", "status");
CREATE INDEX IF NOT EXISTS "refunds_status_idx"            ON "refunds" ("status");
