-- Switch newly created projects to the registered retail Domain Pack.
-- Historical migrations remain immutable; this migration only changes the live default
-- and lets the project service refresh each existing workspace's composition lock.
ALTER TABLE "projects"
  ALTER COLUMN "agent_profile_id" SET DEFAULT 'shopgate.retail-ops';

UPDATE "projects"
SET "agent_profile_id" = 'shopgate.retail-ops',
    "agent_profile_version" = '1.0.0'
WHERE "agent_profile_id" = 'shopgate.finance-research';
