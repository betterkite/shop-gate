-- Expand durable execution ownership without inventing Projects for accounts.
-- Existing identifiers, events, workspace keys and fencing counters are retained.
BEGIN;
CREATE TABLE agent_execution_scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  dataset_id TEXT,
  project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
  owner_user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shared_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT agent_execution_scopes_identity CHECK (
    (kind = 'project_workspace' AND project_id IS NOT NULL AND workspace_id = project_id
      AND owner_user_id IS NULL AND shared_project_id IS NULL AND dataset_id IS NULL)
    OR (kind = 'bi_dataset' AND project_id IS NULL AND dataset_id IS NOT NULL
      AND dataset_id ~ '^[A-Za-z0-9_.:-]{1,120}$'
      AND ((owner_user_id IS NOT NULL AND shared_project_id IS NULL
        AND workspace_id = 'account:' || owner_user_id)
        OR (owner_user_id IS NULL AND shared_project_id IS NOT NULL
          AND workspace_id = shared_project_id AND workspace_id NOT LIKE 'account:%')))
  ),
  CONSTRAINT agent_execution_scopes_kind_workspace_id_dataset_id_key
    UNIQUE(kind, workspace_id, dataset_id)
);

CREATE FUNCTION ensure_agent_project_scope(wanted_project TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
  IF wanted_project IS NULL THEN RAISE EXCEPTION 'An actual project is required'; END IF;
  INSERT INTO agent_execution_scopes(id, kind, workspace_id, project_id)
    VALUES(gen_random_uuid()::text, 'project_workspace', wanted_project, wanted_project)
    ON CONFLICT(project_id) DO UPDATE SET project_id = EXCLUDED.project_id
    RETURNING id INTO result;
  RETURN result;
END $$;

INSERT INTO agent_execution_scopes(id, kind, workspace_id, project_id)
  SELECT gen_random_uuid()::text, 'project_workspace', id, id FROM projects;

CREATE TABLE bi_agent_conversations (
  id TEXT PRIMARY KEY,
  execution_scope_id TEXT NOT NULL REFERENCES agent_execution_scopes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL,
  UNIQUE(id, execution_scope_id, actor_user_id)
);
CREATE INDEX bi_agent_conversations_actor_user_id_execution_scope_id_updated_at_idx
  ON bi_agent_conversations(actor_user_id, execution_scope_id, updated_at);

CREATE TABLE bi_agent_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  execution_scope_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 12000),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  page_scope JSONB NOT NULL CHECK (jsonb_typeof(page_scope) = 'object' AND octet_length(page_scope::text) <= 16384),
  dataset_version INTEGER NOT NULL CHECK (dataset_version > 0),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(conversation_id, execution_scope_id, actor_user_id)
    REFERENCES bi_agent_conversations(id, execution_scope_id, actor_user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE(conversation_id, idempotency_key),
  UNIQUE(id, execution_scope_id, actor_user_id)
);
CREATE INDEX bi_agent_requests_conversation_id_created_at_idx ON bi_agent_requests(conversation_id, created_at);

ALTER TABLE agent_runs ADD COLUMN execution_scope_id TEXT DEFAULT NULL::text;
ALTER TABLE agent_runs ADD COLUMN bi_request_id TEXT;
UPDATE agent_runs r SET execution_scope_id = s.id
  FROM agent_execution_scopes s WHERE s.project_id = r.project_id;
ALTER TABLE agent_runs ALTER COLUMN execution_scope_id SET NOT NULL;
ALTER TABLE agent_runs ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_execution_scope_id_fkey
  FOREIGN KEY(execution_scope_id) REFERENCES agent_execution_scopes(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_bi_request_binding_fkey
  FOREIGN KEY(bi_request_id, execution_scope_id, actor_user_id)
  REFERENCES bi_agent_requests(id, execution_scope_id, actor_user_id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_request_kind CHECK (
  (project_id IS NOT NULL AND bi_request_id IS NULL)
  OR (project_id IS NULL AND request_id IS NULL AND bi_request_id IS NOT NULL AND actor_user_id IS NOT NULL)
);
CREATE INDEX agent_runs_execution_scope_id_created_at_idx ON agent_runs(execution_scope_id, created_at);
CREATE INDEX agent_runs_bi_request_id_created_at_idx ON agent_runs(bi_request_id, created_at);

ALTER TABLE agent_workspace_leases ADD COLUMN execution_scope_id TEXT DEFAULT NULL::text;
UPDATE agent_workspace_leases l SET execution_scope_id = s.id
  FROM agent_execution_scopes s WHERE s.project_id = l.project_id;
ALTER TABLE agent_workspace_leases ALTER COLUMN execution_scope_id SET NOT NULL;
ALTER TABLE agent_workspace_leases DROP CONSTRAINT agent_workspace_leases_pkey;
ALTER TABLE agent_workspace_leases ADD PRIMARY KEY(execution_scope_id);
ALTER TABLE agent_workspace_leases ALTER COLUMN project_id DROP NOT NULL;
CREATE UNIQUE INDEX agent_workspace_leases_project_id_key ON agent_workspace_leases(project_id);
ALTER TABLE agent_workspace_leases ADD CONSTRAINT agent_workspace_leases_execution_scope_id_fkey
  FOREIGN KEY(execution_scope_id) REFERENCES agent_execution_scopes(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve old callers while strictly validating the new ownership boundary.
CREATE FUNCTION guard_agent_scope_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope agent_execution_scopes%ROWTYPE;
BEGIN
  IF NEW.execution_scope_id IS NULL AND NEW.project_id IS NOT NULL THEN
    NEW.execution_scope_id := ensure_agent_project_scope(NEW.project_id);
  END IF;
  SELECT * INTO STRICT scope FROM agent_execution_scopes WHERE id = NEW.execution_scope_id;
  IF (scope.kind = 'project_workspace' AND NEW.project_id IS DISTINCT FROM scope.project_id)
    OR (scope.kind = 'bi_dataset' AND NEW.project_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Execution scope binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.execution_scope_id, NEW.project_id)
    IS DISTINCT FROM (OLD.execution_scope_id, OLD.project_id) THEN
    RAISE EXCEPTION 'Execution ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_scope_binding BEFORE INSERT OR UPDATE OF execution_scope_id, project_id
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION guard_agent_scope_binding();
CREATE TRIGGER agent_workspace_leases_scope_binding BEFORE INSERT OR UPDATE OF execution_scope_id, project_id
  ON agent_workspace_leases FOR EACH ROW EXECUTE FUNCTION guard_agent_scope_binding();

CREATE FUNCTION guard_bi_conversation_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope agent_execution_scopes%ROWTYPE;
BEGIN
  SELECT * INTO STRICT scope FROM agent_execution_scopes WHERE id = NEW.execution_scope_id;
  IF scope.kind <> 'bi_dataset' OR (scope.owner_user_id IS NOT NULL
    AND scope.owner_user_id <> NEW.actor_user_id) THEN
    RAISE EXCEPTION 'BI conversation ownership mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.execution_scope_id, NEW.actor_user_id)
    IS DISTINCT FROM (OLD.execution_scope_id, OLD.actor_user_id) THEN
    RAISE EXCEPTION 'Conversation ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bi_agent_conversations_owner BEFORE INSERT OR UPDATE OF execution_scope_id, actor_user_id
  ON bi_agent_conversations FOR EACH ROW EXECUTE FUNCTION guard_bi_conversation_owner();

CREATE FUNCTION guard_agent_scope_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Execution scope identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_execution_scopes_identity BEFORE UPDATE ON agent_execution_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_agent_scope_identity();
CREATE TRIGGER bi_agent_requests_immutable BEFORE UPDATE ON bi_agent_requests
  FOR EACH ROW EXECUTE FUNCTION guard_agent_scope_identity();

-- A physical BI execution must never be relabelled as another user's request.
CREATE FUNCTION guard_bi_run_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bi_request_id IS NOT NULL AND
    (NEW.bi_request_id, NEW.actor_user_id, NEW.request_id)
    IS DISTINCT FROM (OLD.bi_request_id, OLD.actor_user_id, OLD.request_id) THEN
    RAISE EXCEPTION 'BI execution request is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_bi_identity BEFORE UPDATE OF bi_request_id, actor_user_id, request_id
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION guard_bi_run_identity();

COMMIT;
