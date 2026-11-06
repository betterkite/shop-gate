BEGIN;
-- Session references intentionally survive logout/deletion. Execution rechecks
-- the real auth_sessions row; legacy NULL requests are never executable.
ALTER TABLE bi_agent_requests ADD COLUMN session_id TEXT;
ALTER TABLE bi_agent_requests ADD CONSTRAINT bi_agent_requests_session_reference
  CHECK (session_id IS NULL OR session_id ~ '^[A-Za-z0-9_.:-]{1,120}$');
ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TIMESTAMP(3);
COMMIT;
