-- PRD-003 Ticket 3.4 — Mission completion + client validation + Payment capture.
--
-- Migration MINIMALE :
--   1. Renommage de la valeur enum `MissionStatus.AWAITING_CLIENT_VALIDATION`
--      → `CLIENT_VALIDATION_PENDING` pour aligner Design §3.5 v0.2 et les state
--      machines rev2 (PRD-003 livrable 4/5). La valeur sortante n'a jamais été
--      utilisée en production (état réservé hors PRD-002 — cf. commentaire
--      `schema.prisma`), le renommage est donc safe.
--
-- Tout le reste du périmètre Ticket 3.4 (transitions, audit `MissionEvent`,
-- `Payment.amountCapturedCents`, `AutoReleaseJob`) réutilise des colonnes
-- déjà présentes en schéma (cf. PRD-003 Design + migrations 3.1 / 3.2).
--
-- ⚠️ Limitation Postgres : `ALTER TYPE ... RENAME VALUE` doit s'exécuter hors
-- transaction (Prisma migrate l'exécute en mode `simple` quand chaque
-- statement est seul). Pas d'autre statement dans ce fichier pour éviter le
-- crash `ALTER TYPE ... cannot run inside a transaction block`.

ALTER TYPE "MissionStatus"
  RENAME VALUE 'AWAITING_CLIENT_VALIDATION' TO 'CLIENT_VALIDATION_PENDING';
