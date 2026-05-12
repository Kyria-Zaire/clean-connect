-- =============================================================================
-- Migration : PRD-002 Build — MissionEvent + flags vérification/suspension User
-- Sprint 2 (BMAD Build, contraintes CTO §1 et §5).
--
-- Inclut :
--   - users.verified_at (TIMESTAMPTZ, default NOW())  — exclusion matching si null
--   - users.suspended_at (TIMESTAMPTZ, nullable)      — exclusion matching si non null
--   - Indices supports matching/admin
--   - mission_events (audit minimal)
--
-- Compatible pré-prod / prod : NON destructif. La rétro-compat avec PRD-001 est
-- assurée par un default NOW() sur verified_at (tous les comptes existants
-- restent considérés comme vérifiés — l'introduction d'un workflow de vérif.
-- réel relève d'un PRD ultérieur).
-- =============================================================================

-- 1. Colonnes verified_at / suspended_at sur users -------------------------------
ALTER TABLE "users"
  ADD COLUMN "verified_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "suspended_at" TIMESTAMP(3);

CREATE INDEX "users_verified_at_idx"  ON "users"("verified_at");
CREATE INDEX "users_suspended_at_idx" ON "users"("suspended_at");

-- 2. Table mission_events --------------------------------------------------------
CREATE TABLE "mission_events" (
  "id"             UUID NOT NULL,
  "mission_id"     UUID NOT NULL,
  "type"           VARCHAR(64) NOT NULL,
  "actor_user_id"  UUID,
  "payload"        JSONB,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mission_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "mission_events"
  ADD CONSTRAINT "mission_events_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mission_events"
  ADD CONSTRAINT "mission_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "mission_events_mission_id_created_at_idx"
  ON "mission_events"("mission_id", "created_at");

CREATE INDEX "mission_events_type_idx" ON "mission_events"("type");
