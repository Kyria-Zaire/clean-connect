-- =============================================================================
-- Migration init — Clean Connect
-- Sprint 0.2 — 11 mai 2026
--
-- IMPORTANT — Cette migration est ÉDITÉE MANUELLEMENT (cf. ADR-003) :
--   1. `CREATE EXTENSION` doit s'exécuter AVANT toute table utilisant PostGIS.
--   2. La colonne `location` (type GEOGRAPHY) est créée à la main car Prisma ne
--      sait pas la générer depuis `Unsupported("geography(Point, 4326)")`.
--   3. L'index GIST sur location est créé à la main.
-- =============================================================================

-- ----- Extensions -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ----- Enums ------------------------------------------------------------------
CREATE TYPE "Role" AS ENUM ('CLIENT', 'PRESTATAIRE', 'ADMIN');
CREATE TYPE "MissionStatus" AS ENUM ('DRAFT', 'REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "PhotoType" AS ENUM ('BEFORE', 'AFTER');

-- ----- Table: addresses -------------------------------------------------------
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "street" VARCHAR(255) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "zip_code" VARCHAR(10) NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'FR',
    "location" geography(Point, 4326) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "addresses_city_idx" ON "addresses" ("city");
CREATE INDEX "addresses_zip_code_idx" ON "addresses" ("zip_code");
-- Index GIST critique pour ST_DWithin (matching) — cf. ADR-003
CREATE INDEX "addresses_location_gist" ON "addresses" USING GIST ("location");

-- ----- Table: users -----------------------------------------------------------
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "stripe_customer_id" TEXT,
    "stripe_account_id" TEXT,
    "address_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users" ("stripe_customer_id");
CREATE UNIQUE INDEX "users_stripe_account_id_key" ON "users" ("stripe_account_id");
CREATE UNIQUE INDEX "users_address_id_key" ON "users" ("address_id");
CREATE INDEX "users_role_idx" ON "users" ("role");
CREATE INDEX "users_deleted_at_idx" ON "users" ("deleted_at");

ALTER TABLE "users"
    ADD CONSTRAINT "users_address_id_fkey"
    FOREIGN KEY ("address_id") REFERENCES "addresses" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----- Table: missions --------------------------------------------------------
CREATE TABLE "missions" (
    "id" UUID NOT NULL,
    "status" "MissionStatus" NOT NULL DEFAULT 'DRAFT',
    "client_id" UUID NOT NULL,
    "prestataire_id" UUID,
    "address_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "commission_cents" INTEGER NOT NULL,
    "payout_cents" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "missions_stripe_payment_intent_id_key" ON "missions" ("stripe_payment_intent_id");
CREATE INDEX "missions_status_idx" ON "missions" ("status");
CREATE INDEX "missions_client_id_idx" ON "missions" ("client_id");
CREATE INDEX "missions_prestataire_id_idx" ON "missions" ("prestataire_id");
CREATE INDEX "missions_scheduled_at_idx" ON "missions" ("scheduled_at");

ALTER TABLE "missions"
    ADD CONSTRAINT "missions_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missions"
    ADD CONSTRAINT "missions_prestataire_id_fkey"
    FOREIGN KEY ("prestataire_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missions"
    ADD CONSTRAINT "missions_address_id_fkey"
    FOREIGN KEY ("address_id") REFERENCES "addresses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Garde-fou comptable : commission + payout = amount (cf. ADR-002)
ALTER TABLE "missions"
    ADD CONSTRAINT "missions_amounts_consistency_check"
    CHECK ("amount_cents" = "commission_cents" + "payout_cents");

ALTER TABLE "missions"
    ADD CONSTRAINT "missions_amount_positive_check"
    CHECK ("amount_cents" > 0 AND "commission_cents" >= 0 AND "payout_cents" >= 0);

-- ----- Table: photos ----------------------------------------------------------
-- L'id est généré CÔTÉ CLIENT (UUID v4) pour idempotence offline — cf. cahier v1.4 §6
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "type" "PhotoType" NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "photos_mission_id_type_idx" ON "photos" ("mission_id", "type");

ALTER TABLE "photos"
    ADD CONSTRAINT "photos_mission_id_fkey"
    FOREIGN KEY ("mission_id") REFERENCES "missions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
