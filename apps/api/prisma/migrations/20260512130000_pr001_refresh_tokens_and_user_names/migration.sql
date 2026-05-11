-- =============================================================================
-- PRD-001 — Auth JWT : colonnes prénom/nom utilisateur + table refresh_tokens
-- =============================================================================

-- ----- Utilisateur : prénom / nom (obligatoires, backfill pour lignes existantes)
ALTER TABLE "users" ADD COLUMN "first_name" VARCHAR(80);
ALTER TABLE "users" ADD COLUMN "last_name" VARCHAR(80);

UPDATE "users"
SET
  "first_name" = COALESCE("first_name", 'Inconnu'),
  "last_name" = COALESCE("last_name", 'Inconnu')
WHERE "first_name" IS NULL OR "last_name" IS NULL;

ALTER TABLE "users" ALTER COLUMN "first_name" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "last_name" SET NOT NULL;

-- ----- Refresh tokens (opaque côté client, hash sha256 côté serveur)
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" ("token_hash");

CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id");

CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
