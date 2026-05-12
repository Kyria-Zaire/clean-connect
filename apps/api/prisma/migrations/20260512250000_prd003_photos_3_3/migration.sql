-- PRD-003 Ticket 3.3 — Cloudinary signed upload + PhotoUploadSession lifecycle
--
-- Ajouts (ALTER non destructifs, tables vides en dev/rec/preprod) :
--   1. photo_upload_sessions : `variant`, `capture_client_uuid`, `mime_type`,
--      `cloudinary_public_id`. Index sur `expires_at` (orphan cleanup Ticket 3.5).
--   2. photos : `uploaded_by_user_id` (FK users, audit RGPD + RBAC lecture).
--   3. photos : index unique sur `cloudinary_public_id` (anti double-link Cloudinary).
--   4. photos : index secondaire sur `uploaded_by_user_id` (lecture par uploader).
--
-- Rule photos-rgpd : aucune URL publique permanente ; toute lecture passe par
-- signed URL <= 5min. Le `tokenDigest` reste secret (SHA-256, jamais loggé,
-- jamais sérialisé public).

-- 1. photo_upload_sessions — colonnes ajoutées (NOT NULL car tables vides).
ALTER TABLE "photo_upload_sessions"
  ADD COLUMN "variant" "PhotoVariant" NOT NULL DEFAULT 'ORIGINAL',
  ADD COLUMN "capture_client_uuid" UUID NOT NULL,
  ADD COLUMN "mime_type" VARCHAR(32) NOT NULL,
  ADD COLUMN "cloudinary_public_id" VARCHAR(1024) NOT NULL;

CREATE INDEX "photo_upload_sessions_expires_at_idx"
  ON "photo_upload_sessions"("expires_at");

-- 2. photos — uploadedByUserId FK + index.
ALTER TABLE "photos"
  ADD COLUMN "uploaded_by_user_id" UUID NOT NULL;

ALTER TABLE "photos"
  ADD CONSTRAINT "photos_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. UNIQUE cloudinary_public_id — anti double-link Cloudinary (un même asset
-- ne peut pas être référencé par 2 lignes Photo distinctes). `cloudinary_public_id`
-- est NULLABLE côté Prisma (tombstone post-purge) : Postgres autorise plusieurs
-- NULL distincts dans un UNIQUE → on couvre uniquement les valeurs renseignées.
CREATE UNIQUE INDEX "photos_cloudinary_public_id_key"
  ON "photos"("cloudinary_public_id");

-- 4. Index lookup uploader (RBAC lecture + purge RGPD scoped).
CREATE INDEX "photos_uploaded_by_user_id_idx"
  ON "photos"("uploaded_by_user_id");
