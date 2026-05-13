-- =============================================================================
-- PRD-004 Ticket 4.5 Build itération 2 — Invariants atomiques + lifecycle ACK
-- -----------------------------------------------------------------------------
-- Source : PRD-004 §4.15.16 Build itération 2 + Verify rapport 2026-05-13.
--
-- Changements :
--  1. Enum `FinanceMismatchStatus` : ajout `ACKNOWLEDGED` (entre OPEN et INVESTIGATING).
--  2. Table `finance_mismatches` :
--      - + `mismatch_code` VARCHAR(16) NOT NULL — code invariant déterministe
--        versionné (`FIN-I-001` … `FIN-I-011`, `FIN-J-001`).
--      - + `acknowledged_at` TIMESTAMP(3) NULL — étape lifecycle.
--      - + `acknowledged_by_user_id` UUID NULL — audit (ADMIN id).
--      - Drop unique `(run_id, resource_kind, resource_id)` ⇒ remplacé par
--        `(run_id, mismatch_code, resource_kind, resource_id)` (un même run peut
--        casser plusieurs invariants distincts sur la même ressource).
--      - + index `(mismatch_code, detected_at)` pour drill-down par code.
-- =============================================================================

-- 1. Enum lifecycle — Postgres : ALTER TYPE ADD VALUE est non-transactionnel
--    (commit auto). Doit être hors d'une transaction Prisma. Heureusement
--    `prisma migrate deploy` exécute chaque fichier hors transaction si la
--    première instruction est `ALTER TYPE … ADD VALUE`. On respecte cet ordre.
ALTER TYPE "FinanceMismatchStatus" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED' BEFORE 'INVESTIGATING';

-- 2. Colonnes additionnelles — `mismatch_code` NOT NULL avec default temporaire
--    pour les rows héritées (Build itération 1 a livré la table sans données prod).
ALTER TABLE "finance_mismatches"
  ADD COLUMN "mismatch_code" VARCHAR(16) NOT NULL DEFAULT 'FIN-LEGACY';
ALTER TABLE "finance_mismatches" ALTER COLUMN "mismatch_code" DROP DEFAULT;

ALTER TABLE "finance_mismatches"
  ADD COLUMN "acknowledged_at" TIMESTAMP(3),
  ADD COLUMN "acknowledged_by_user_id" UUID;

-- 3. Réindexation unicité naturelle dedup invariant.
DROP INDEX IF EXISTS "finance_mismatches_run_id_resource_kind_resource_id_key";
CREATE UNIQUE INDEX "finance_mismatches_run_code_resource_key"
  ON "finance_mismatches"("run_id", "mismatch_code", "resource_kind", "resource_id");

CREATE INDEX "finance_mismatches_mismatch_code_detected_at_idx"
  ON "finance_mismatches"("mismatch_code", "detected_at");
