-- =============================================================================
-- Migration : PRD-003 Design — Payment / Transfer / Webhooks / Photo extensions
-- Sprint 3 (BMAD Design — ajustements CTO 2026-05-12 + ajustements de revue).
--
-- ⚠️  STATUT : Design uniquement. Ne PAS appliquer en main avant :
--      - sign-off CTO Design
--      - pré-revue `reviewer-securite-code`
--   Application locale/CI autorisée pour validation technique (décision CTO).
--
-- Ajustements de revue intégrés :
--   - payments.provider_payout_cents (snapshot net prestataire, lock-in commission)
--   - payments check application_fee <= amount_authorized + cohérence provider_payout
--   - transfers.retry_count / last_retry_at / failure_reason (rename failure_message)
--   - stripe_webhook_events.created_at (rename received_at, convention projet)
--   - auto_release_jobs.locked_at / locked_by (verrou applicatif anti-double exécution)
--   - photos.capture_client_uuid NOT NULL (idempotence renforcée, anti NULL multiples)
--
-- Entités ajoutées :
--   - enums : PhotoVariant, PaymentStatus, TransferStatus,
--             StripeWebhookProcessingStatus, ProviderPayoutStatus,
--             AutoReleaseJobStatus, WebhookDeadLetterSource,
--             PhotoDeletionReason, PhotoDeletionActor
--   - tables : payments, transfers, stripe_webhook_events,
--              webhook_dead_letters, auto_release_jobs,
--              photo_upload_sessions, photo_deletion_logs
--   - extension users : capabilities Stripe + providerPayoutStatus
--   - extension photos : variant, capture_client_uuid (NOT NULL), GPS, checksum_sha256,
--                         flag_suspicious, syncedAt, deletedAt, FK session
--   - DROP missions.stripe_payment_intent_id (déplacé sur payments)
--
-- Sécurité / décisions CTO :
--   - Idempotence : transfers.idempotency_key UNIQUE
--                   auto_release_jobs.idempotency_key UNIQUE
--                   stripe_webhook_events.stripe_event_id PK (UNIQUE implicite)
--   - Anti-replay webhook : payload_hash sha256 + processing_status + created_at
--   - PhotoUploadSession.token_digest = sha256(token) — secret jamais stocké
--   - Soft-delete photos par tombstone deleted_at (jamais suppression manuelle)
--   - Verrou applicatif AutoReleaseJob (locked_at/locked_by) — V10 Verify
-- =============================================================================

-- 1. Enums --------------------------------------------------------------------

CREATE TYPE "PhotoVariant" AS ENUM ('ORIGINAL', 'DISPLAY');

CREATE TYPE "PaymentStatus" AS ENUM ('AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'REVERSED');

CREATE TYPE "StripeWebhookProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

CREATE TYPE "ProviderPayoutStatus" AS ENUM (
  'NOT_ONBOARDED',
  'ONBOARDING_IN_PROGRESS',
  'IDENTITY_PENDING',
  'PAYOUTS_DISABLED',
  'CHARGES_DISABLED',
  'READY'
);

CREATE TYPE "AutoReleaseJobStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'SUCCEEDED', 'CANCELLED', 'FAILED');

CREATE TYPE "WebhookDeadLetterSource" AS ENUM ('STRIPE', 'CLOUDINARY');

CREATE TYPE "PhotoDeletionReason" AS ENUM (
  'RETENTION_POLICY',
  'LEGAL_HOLD',
  'FRAUD_INVESTIGATION',
  'ADMIN_ACTION'
);

CREATE TYPE "PhotoDeletionActor" AS ENUM ('SYSTEM', 'ADMIN');

-- 2. Extension users : capabilities Stripe + ProviderPayoutStatus -------------

ALTER TABLE "users"
  ADD COLUMN "stripe_charges_enabled"   BOOLEAN,
  ADD COLUMN "stripe_transfers_enabled" BOOLEAN,
  ADD COLUMN "stripe_payouts_enabled"   BOOLEAN,
  ADD COLUMN "stripe_requirements_due"  JSONB,
  ADD COLUMN "provider_payout_status"   "ProviderPayoutStatus" NOT NULL DEFAULT 'NOT_ONBOARDED';

CREATE INDEX "users_provider_payout_status_idx" ON "users" ("provider_payout_status");

-- 3. Mission : retrait stripe_payment_intent_id (déplacé sur payments) -------
--    Suppression de l'index UNIQUE puis de la colonne. Si des valeurs
--    existent (recette / preprod), elles devront être migrées dans `payments`
--    via un script de data migration AVANT application en prod (cf. PRD-003 §4).

DROP INDEX IF EXISTS "missions_stripe_payment_intent_id_key";
ALTER TABLE "missions" DROP COLUMN IF EXISTS "stripe_payment_intent_id";

-- 4. Table payments -----------------------------------------------------------

CREATE TABLE "payments" (
  "id"                        UUID         NOT NULL,
  "mission_id"                UUID         NOT NULL,
  "stripe_payment_intent_id"  VARCHAR(255) NOT NULL,
  "amount_authorized_cents"   INTEGER      NOT NULL,
  "amount_captured_cents"     INTEGER,
  "currency"                  VARCHAR(3)   NOT NULL DEFAULT 'eur',
  -- Commission plateforme snapshotée au paiement, appliquée au Transfer différé. Immutable.
  "application_fee_cents"     INTEGER,
  -- Montant net prestataire snapshoté (= amount_authorized - application_fee), lock-in au paiement.
  "provider_payout_cents"     INTEGER,
  "vat_rate_snapshot"         DECIMAL(5,4),
  "status"                    "PaymentStatus" NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payments_mission_id_key" ON "payments" ("mission_id");
CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_key" ON "payments" ("stripe_payment_intent_id");
CREATE INDEX "payments_status_idx" ON "payments" ("status");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_authorized_positive_check"
  CHECK ("amount_authorized_cents" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_captured_lte_authorized_check"
  CHECK ("amount_captured_cents" IS NULL OR "amount_captured_cents" <= "amount_authorized_cents");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_application_fee_lte_authorized_check"
  CHECK ("application_fee_cents" IS NULL OR "application_fee_cents" <= "amount_authorized_cents");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_payout_consistent_check"
  CHECK (
    ("application_fee_cents" IS NULL AND "provider_payout_cents" IS NULL)
    OR ("application_fee_cents" IS NOT NULL AND "provider_payout_cents" IS NOT NULL
        AND "provider_payout_cents" = "amount_authorized_cents" - "application_fee_cents")
  );

-- 5. Table transfers ----------------------------------------------------------

CREATE TABLE "transfers" (
  "id"                  UUID            NOT NULL,
  "payment_id"          UUID            NOT NULL,
  "stripe_transfer_id"  VARCHAR(255),
  "amount_cents"        INTEGER         NOT NULL,
  "currency"            VARCHAR(3)      NOT NULL DEFAULT 'eur',
  "status"              "TransferStatus" NOT NULL,
  "idempotency_key"     VARCHAR(255)    NOT NULL,
  -- Retry metadata (CTO ajustement Design)
  "retry_count"         INTEGER         NOT NULL DEFAULT 0,
  "last_retry_at"       TIMESTAMP(3),
  "failure_code"        VARCHAR(120),
  -- failure_reason : message Stripe ou erreur interne (audit + alerte ops)
  "failure_reason"      TEXT,
  "created_at"          TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)    NOT NULL,

  CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transfers_payment_id_key" ON "transfers" ("payment_id");
CREATE UNIQUE INDEX "transfers_stripe_transfer_id_key" ON "transfers" ("stripe_transfer_id");
CREATE UNIQUE INDEX "transfers_idempotency_key_key" ON "transfers" ("idempotency_key");
CREATE INDEX "transfers_status_idx" ON "transfers" ("status");

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive_check"
  CHECK ("amount_cents" > 0);

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_retry_count_non_negative_check"
  CHECK ("retry_count" >= 0);

-- 6. Table stripe_webhook_events (anti-replay) --------------------------------

CREATE TABLE "stripe_webhook_events" (
  -- PRIMARY KEY assure l'unicité de stripe_event_id (anti-replay).
  "stripe_event_id"        VARCHAR(255)                    NOT NULL,
  "type"                   VARCHAR(120)                    NOT NULL,
  "payload_hash"           VARCHAR(64)                     NOT NULL,
  "livemode"               BOOLEAN                         NOT NULL,
  "processing_status"      "StripeWebhookProcessingStatus" NOT NULL DEFAULT 'PENDING',
  "created_at"             TIMESTAMP(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_started_at"  TIMESTAMP(3),
  "processed_at"           TIMESTAMP(3),
  "last_error"             TEXT,

  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("stripe_event_id")
);

CREATE INDEX "stripe_webhook_events_processing_status_created_at_idx"
  ON "stripe_webhook_events" ("processing_status", "created_at");

-- 7. Table webhook_dead_letters (DLQ) -----------------------------------------

CREATE TABLE "webhook_dead_letters" (
  "id"                UUID                       NOT NULL,
  "source"            "WebhookDeadLetterSource"  NOT NULL,
  "external_event_id" VARCHAR(255)               NOT NULL,
  "payload_hash"      VARCHAR(64),
  "error_message"     TEXT                       NOT NULL,
  "attempts"          INTEGER                    NOT NULL DEFAULT 0,
  "last_attempt_at"   TIMESTAMP(3)               NOT NULL,
  "resolved_at"       TIMESTAMP(3),
  "created_at"        TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_dead_letters_source_external_event_id_idx"
  ON "webhook_dead_letters" ("source", "external_event_id");

-- 8. Table auto_release_jobs (traçabilité) ------------------------------------

CREATE TABLE "auto_release_jobs" (
  "id"              UUID                   NOT NULL,
  "mission_id"      UUID                   NOT NULL,
  "scheduled_for"   TIMESTAMP(3)           NOT NULL,
  "status"          "AutoReleaseJobStatus" NOT NULL,
  "bull_job_id"     VARCHAR(128),
  "idempotency_key" VARCHAR(255),
  "cancel_reason"   VARCHAR(255),
  "last_error"      TEXT,
  -- Verrou applicatif anti-double-exécution simultanée (CTO ajustement Design)
  "locked_at"       TIMESTAMP(3),
  "locked_by"       VARCHAR(255),
  "started_at"      TIMESTAMP(3),
  "finished_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3)           NOT NULL,

  CONSTRAINT "auto_release_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_release_jobs_bull_job_id_key" ON "auto_release_jobs" ("bull_job_id");
CREATE UNIQUE INDEX "auto_release_jobs_idempotency_key_key" ON "auto_release_jobs" ("idempotency_key");
CREATE INDEX "auto_release_jobs_mission_id_status_idx" ON "auto_release_jobs" ("mission_id", "status");
CREATE INDEX "auto_release_jobs_scheduled_for_status_idx" ON "auto_release_jobs" ("scheduled_for", "status");
CREATE INDEX "auto_release_jobs_locked_at_idx" ON "auto_release_jobs" ("locked_at");

ALTER TABLE "auto_release_jobs"
  ADD CONSTRAINT "auto_release_jobs_lock_pair_check"
  CHECK (
    ("locked_at" IS NULL AND "locked_by" IS NULL)
    OR ("locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
  );

ALTER TABLE "auto_release_jobs"
  ADD CONSTRAINT "auto_release_jobs_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 9. Table photo_upload_sessions ----------------------------------------------

CREATE TABLE "photo_upload_sessions" (
  "id"                UUID         NOT NULL,
  "mission_id"        UUID         NOT NULL,
  "uploader_user_id"  UUID         NOT NULL,
  "phase"             "PhotoType"  NOT NULL,
  "token_digest"      VARCHAR(64)  NOT NULL,
  "expires_at"        TIMESTAMP(3) NOT NULL,
  "consumed_at"       TIMESTAMP(3),
  "max_bytes"         INTEGER      NOT NULL DEFAULT 10485760,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "photo_upload_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "photo_upload_sessions_token_digest_key" ON "photo_upload_sessions" ("token_digest");
CREATE INDEX "photo_upload_sessions_mission_id_phase_idx" ON "photo_upload_sessions" ("mission_id", "phase");

ALTER TABLE "photo_upload_sessions"
  ADD CONSTRAINT "photo_upload_sessions_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "photo_upload_sessions"
  ADD CONSTRAINT "photo_upload_sessions_uploader_user_id_fkey"
  FOREIGN KEY ("uploader_user_id") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "photo_upload_sessions"
  ADD CONSTRAINT "photo_upload_sessions_max_bytes_positive_check"
  CHECK ("max_bytes" > 0 AND "max_bytes" <= 10485760);

-- 10. Extension photos --------------------------------------------------------

ALTER TABLE "photos"
  ADD COLUMN "variant"                 "PhotoVariant" NOT NULL DEFAULT 'DISPLAY',
  -- capture_client_uuid : ajouté NULLABLE pour le backfill, contraint NOT NULL en fin d'étape.
  ADD COLUMN "capture_client_uuid"     UUID,
  ADD COLUMN "photo_upload_session_id" UUID,
  ADD COLUMN "cloudinary_public_id"    VARCHAR(1024),
  ADD COLUMN "checksum_sha256"         VARCHAR(64),
  ADD COLUMN "gps_latitude"            DECIMAL(10,8),
  ADD COLUMN "gps_longitude"           DECIMAL(11,8),
  ADD COLUMN "gps_accuracy_meters"     INTEGER,
  ADD COLUMN "gps_missing"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "flag_suspicious"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "synced_at"               TIMESTAMP(3),
  ADD COLUMN "image_width"             INTEGER,
  ADD COLUMN "image_height"            INTEGER,
  ADD COLUMN "bytes"                   INTEGER,
  ADD COLUMN "deleted_at"              TIMESTAMP(3);

-- Backfill défensif : pour les photos PRD-002 (legacy mono-variant) sans capture_client_uuid,
-- on réutilise l'UUID logique de la ligne (les `photos.id` PRD-002 sont eux-mêmes générés v4 côté client).
UPDATE "photos" SET "capture_client_uuid" = "id" WHERE "capture_client_uuid" IS NULL;

-- captureClientUuid devient OBLIGATOIRE (CTO ajustement Design) — protège l'idempotence et
-- évite que PostgreSQL accepte plusieurs NULLs malgré la contrainte UNIQUE.
ALTER TABLE "photos" ALTER COLUMN "capture_client_uuid" SET NOT NULL;

-- Unicité paire ORIGINAL+DISPLAY par capture mobile (capture_client_uuid désormais NOT NULL).
CREATE UNIQUE INDEX "photos_mission_id_capture_client_uuid_variant_key"
  ON "photos" ("mission_id", "capture_client_uuid", "variant");

CREATE INDEX "photos_photo_upload_session_id_idx" ON "photos" ("photo_upload_session_id");

ALTER TABLE "photos"
  ADD CONSTRAINT "photos_photo_upload_session_id_fkey"
  FOREIGN KEY ("photo_upload_session_id") REFERENCES "photo_upload_sessions" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Garde-fous données photo
ALTER TABLE "photos"
  ADD CONSTRAINT "photos_gps_pair_check"
  CHECK (
    ("gps_latitude" IS NULL AND "gps_longitude" IS NULL)
    OR ("gps_latitude" IS NOT NULL AND "gps_longitude" IS NOT NULL)
  );

ALTER TABLE "photos"
  ADD CONSTRAINT "photos_bytes_positive_check"
  CHECK ("bytes" IS NULL OR "bytes" > 0);

-- 11. Table photo_deletion_logs (audit purge) ---------------------------------

CREATE TABLE "photo_deletion_logs" (
  "id"            UUID                   NOT NULL,
  "photo_id"      UUID                   NOT NULL,
  "mission_id"    UUID                   NOT NULL,
  "reason"        "PhotoDeletionReason"  NOT NULL,
  "performed_by"  "PhotoDeletionActor"   NOT NULL,
  "batch_id"      VARCHAR(64),
  "metadata"      JSONB,
  "created_at"    TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "photo_deletion_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "photo_deletion_logs_mission_id_created_at_idx"
  ON "photo_deletion_logs" ("mission_id", "created_at");

CREATE INDEX "photo_deletion_logs_batch_id_idx"
  ON "photo_deletion_logs" ("batch_id");

ALTER TABLE "photo_deletion_logs"
  ADD CONSTRAINT "photo_deletion_logs_photo_id_fkey"
  FOREIGN KEY ("photo_id") REFERENCES "photos" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "photo_deletion_logs"
  ADD CONSTRAINT "photo_deletion_logs_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
