-- =============================================================================
-- PRD-004 Ticket 4.5 — Monitoring financier (Build)
-- -----------------------------------------------------------------------------
-- Source : PRD-004 §4.15.4 + ADR-018 §2.4.
-- Tables : finance_reconciliation_runs, finance_mismatches, finance_daily_reports,
--          finance_alerts, finance_scheduler_locks (lock anti-overlap CTO).
-- Enums  : FinanceRunType, FinanceRunStatus, FinanceMismatchType,
--          FinanceResourceKind, FinanceMismatchStatus.
-- =============================================================================

-- CreateEnum
CREATE TYPE "FinanceRunType" AS ENUM ('RECONCILE', 'STUCK', 'INVARIANTS', 'REPORT', 'PAYOUT_ANOMALY');

-- CreateEnum
CREATE TYPE "FinanceRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FinanceMismatchType" AS ENUM ('STATUS', 'AMOUNT', 'CURRENCY', 'MISSING_DB', 'MISSING_STRIPE', 'INVARIANT_SUM', 'STUCK_PENDING', 'STUCK_AUTHORIZATION', 'STUCK_CAPTURED', 'PAYOUT_ANOMALY');

-- CreateEnum
CREATE TYPE "FinanceResourceKind" AS ENUM ('PAYMENT', 'TRANSFER', 'REFUND', 'INVARIANT');

-- CreateEnum
CREATE TYPE "FinanceMismatchStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED');

-- CreateTable
CREATE TABLE "finance_reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "FinanceRunType" NOT NULL,
    "status" "FinanceRunStatus" NOT NULL,
    "window_from" TIMESTAMP(3) NOT NULL,
    "window_to" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "resources_scanned" INTEGER NOT NULL DEFAULT 0,
    "mismatches_found" INTEGER NOT NULL DEFAULT 0,
    "alerts_emitted" INTEGER NOT NULL DEFAULT 0,
    "failure_message" TEXT,
    "triggered_by_user_id" UUID,

    CONSTRAINT "finance_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_mismatches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "type" "FinanceMismatchType" NOT NULL,
    "resource_kind" "FinanceResourceKind" NOT NULL,
    "resource_id" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(8) NOT NULL,
    "amount_delta_cents" INTEGER,
    "db_snapshot" JSONB NOT NULL,
    "stripe_snapshot" JSONB,
    "status" "FinanceMismatchStatus" NOT NULL DEFAULT 'OPEN',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "resolution_notes" VARCHAR(1024),

    CONSTRAINT "finance_mismatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_daily_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_date" DATE NOT NULL,
    "window_from" TIMESTAMP(3) NOT NULL,
    "window_to" TIMESTAMP(3) NOT NULL,
    "captured_cents" INTEGER NOT NULL DEFAULT 0,
    "transfer_sent_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "commission_cents" INTEGER NOT NULL DEFAULT 0,
    "invariant_balance_cents" INTEGER NOT NULL,
    "captured_count" INTEGER NOT NULL DEFAULT 0,
    "transfer_sent_count" INTEGER NOT NULL DEFAULT 0,
    "refunded_count" INTEGER NOT NULL DEFAULT 0,
    "open_mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(8) NOT NULL,
    "mismatch_id" UUID,
    "run_id" UUID,
    "context" JSONB NOT NULL,
    "emitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_scheduler_locks" (
    "key" VARCHAR(64) NOT NULL,
    "owner" VARCHAR(64) NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_scheduler_locks_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "finance_reconciliation_runs_type_status_started_at_idx" ON "finance_reconciliation_runs"("type", "status", "started_at");

-- CreateIndex
CREATE INDEX "finance_reconciliation_runs_started_at_idx" ON "finance_reconciliation_runs"("started_at");

-- CreateIndex
CREATE INDEX "finance_mismatches_status_severity_detected_at_idx" ON "finance_mismatches"("status", "severity", "detected_at");

-- CreateIndex
CREATE INDEX "finance_mismatches_resource_kind_resource_id_idx" ON "finance_mismatches"("resource_kind", "resource_id");

-- CreateIndex
CREATE INDEX "finance_mismatches_type_detected_at_idx" ON "finance_mismatches"("type", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "finance_mismatches_run_id_resource_kind_resource_id_key" ON "finance_mismatches"("run_id", "resource_kind", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_daily_reports_report_date_key" ON "finance_daily_reports"("report_date");

-- CreateIndex
CREATE INDEX "finance_daily_reports_report_date_idx" ON "finance_daily_reports"("report_date");

-- CreateIndex
CREATE INDEX "finance_alerts_severity_kind_emitted_at_idx" ON "finance_alerts"("severity", "kind", "emitted_at");

-- CreateIndex
CREATE INDEX "finance_alerts_mismatch_id_idx" ON "finance_alerts"("mismatch_id");

-- CreateIndex
CREATE INDEX "finance_scheduler_locks_expires_at_idx" ON "finance_scheduler_locks"("expires_at");

-- AddForeignKey
ALTER TABLE "finance_mismatches" ADD CONSTRAINT "finance_mismatches_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "finance_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
