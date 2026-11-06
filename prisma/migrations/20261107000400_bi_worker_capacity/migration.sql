BEGIN;

-- Additive upgrade: legacy consumers retain their original identity and slots.
ALTER TABLE "agent_worker_instances" ADD COLUMN "worker_kind" TEXT NOT NULL DEFAULT 'project_generation';
ALTER TABLE "agent_worker_instances" ADD CONSTRAINT "agent_worker_kind_check"
  CHECK ("worker_kind" IN ('project_generation', 'bi_analysis'));
ALTER TABLE "agent_worker_slots" ADD COLUMN "active_run_id" TEXT;
CREATE UNIQUE INDEX "agent_worker_slots_active_run_id_key" ON "agent_worker_slots"("active_run_id");
ALTER TABLE "agent_worker_slots" ADD CONSTRAINT "agent_worker_slot_identity_check"
  CHECK ("active_job_id" IS NULL OR "active_run_id" IS NULL);

-- Preserve ownership/lease checks while allowing either physical execution kind.
ALTER TABLE "agent_worker_slots" DROP CONSTRAINT "agent_worker_slots_owner_state_check";
ALTER TABLE "agent_worker_slots" ADD CONSTRAINT "agent_worker_slots_owner_state_check" CHECK (
  ("status" = 'free' AND "active_job_id" IS NULL AND "active_run_id" IS NULL
    AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
  OR
  ("status" = 'held' AND (("active_job_id" IS NOT NULL) <> ("active_run_id" IS NOT NULL))
    AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
);

COMMIT;
