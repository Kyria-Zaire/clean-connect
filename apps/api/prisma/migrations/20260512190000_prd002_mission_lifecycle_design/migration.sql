-- =============================================================================
-- PRD-002 — Design : cycle de vie Mission + proposals + rayon prestataire
--
-- BREAKING (pré-prod) : réinitialise `missions` et `photos` (aucune donnée prod).
-- PostGIS : matching sur `addresses.location` (GIST existant) — cf. ADR-003.
-- =============================================================================

-- ----- Reset tables dépendantes ----------------------------------------------
DROP TABLE IF EXISTS "photos" CASCADE;
DROP TABLE IF EXISTS "missions" CASCADE;

DROP TYPE IF EXISTS "MissionStatus";
CREATE TYPE "MissionStatus" AS ENUM (
  'DRAFT',
  'PUBLISHED',
  'PROPOSED',
  'ACCEPTED',
  'EXPIRED',
  'CANCELLED',
  'IN_PROGRESS',
  'AWAITING_CLIENT_VALIDATION',
  'COMPLETED',
  'DISPUTE_OPEN',
  'REFUNDED'
);

CREATE TYPE "MissionServiceType" AS ENUM (
  'SOFA',
  'MATTRESS',
  'TERRACE',
  'TRASH_BINS',
  'CARPET',
  'OTHER'
);

-- ----- Utilisateur : rayon d'intervention ------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "service_radius_km" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "users"
  ADD CONSTRAINT "users_service_radius_km_range_check"
  CHECK ("service_radius_km" >= 1 AND "service_radius_km" <= 30);

-- ----- Table: missions -------------------------------------------------------
CREATE TABLE "missions" (
    "id" UUID NOT NULL,
    "mission_number" VARCHAR(32) NOT NULL,
    "status" "MissionStatus" NOT NULL DEFAULT 'DRAFT',
    "service_type" "MissionServiceType" NOT NULL,
    "client_id" UUID NOT NULL,
    "prestataire_id" UUID,
    "address_id" UUID NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL,
    "is_asap" BOOLEAN NOT NULL DEFAULT false,
    "estimated_price_cents" INTEGER,
    "published_at" TIMESTAMP(3),
    "listing_expires_at" TIMESTAMP(3),
    "stripe_payment_intent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "missions_mission_number_key" ON "missions" ("mission_number");
CREATE UNIQUE INDEX "missions_stripe_payment_intent_id_key" ON "missions" ("stripe_payment_intent_id");
CREATE INDEX "missions_status_idx" ON "missions" ("status");
CREATE INDEX "missions_client_id_idx" ON "missions" ("client_id");
CREATE INDEX "missions_prestataire_id_idx" ON "missions" ("prestataire_id");
CREATE INDEX "missions_start_at_idx" ON "missions" ("start_at");
CREATE INDEX "missions_listing_expires_at_idx" ON "missions" ("listing_expires_at");

ALTER TABLE "missions"
    ADD CONSTRAINT "missions_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missions"
    ADD CONSTRAINT "missions_prestataire_id_fkey"
    FOREIGN KEY ("prestataire_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missions"
    ADD CONSTRAINT "missions_address_id_fkey"
    FOREIGN KEY ("address_id") REFERENCES "addresses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "missions" ADD CONSTRAINT "missions_time_window_check" CHECK ("end_at" > "start_at");

ALTER TABLE "missions"
    ADD CONSTRAINT "missions_estimated_price_positive_check"
    CHECK ("estimated_price_cents" IS NULL OR "estimated_price_cents" > 0);

-- ----- Table: mission_proposals ---------------------------------------------
CREATE TABLE "mission_proposals" (
    "id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "prestataire_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mission_proposals_mission_id_prestataire_id_key" ON "mission_proposals" ("mission_id", "prestataire_id");
CREATE INDEX "mission_proposals_mission_id_idx" ON "mission_proposals" ("mission_id");
CREATE INDEX "mission_proposals_prestataire_id_idx" ON "mission_proposals" ("prestataire_id");

ALTER TABLE "mission_proposals"
    ADD CONSTRAINT "mission_proposals_mission_id_fkey"
    FOREIGN KEY ("mission_id") REFERENCES "missions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_proposals"
    ADD CONSTRAINT "mission_proposals_prestataire_id_fkey"
    FOREIGN KEY ("prestataire_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- Table: photos (identique schéma Sprint 0.2) ---------------------------
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
