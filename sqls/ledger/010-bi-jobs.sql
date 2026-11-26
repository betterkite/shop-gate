-- Explicit forward migration only. Queue worker group never bypasses fact RLS.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shopgate_bi_worker') THEN
    CREATE ROLE shopgate_bi_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shopgate_bi_worker'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unsafe existing BI worker group';
  END IF;
END; $$;

CREATE TABLE bi.jobs (
  workspace_id text NOT NULL, dataset_id text NOT NULL, job_id text NOT NULL,
  actor_id text NOT NULL, session_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('preview_import','prepare_demo','confirm_import','export_standard')),
  base_version bigint NOT NULL CHECK(base_version>0), idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN
    ('queued','running','awaiting_auth','ready_preview','rejected','committed','completed','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued', cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  result jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(result)='object'), error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',
  PRIMARY KEY(workspace_id,dataset_id,job_id), UNIQUE(job_id),
  UNIQUE(workspace_id,dataset_id,actor_id,idempotency_key),
  FOREIGN KEY(workspace_id,dataset_id) REFERENCES bi.datasets,
  CHECK((state='running' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     OR (state<>'running' AND lease_owner IS NULL AND lease_until IS NULL))
);
CREATE INDEX job_queue ON bi.jobs(state,lease_until,created_at,job_id);
CREATE INDEX actor_jobs ON bi.jobs(workspace_id,dataset_id,actor_id,created_at DESC,job_id);

CREATE TABLE bi.job_files (
  workspace_id text NOT NULL, dataset_id text NOT NULL, job_id text NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0 AND ordinal<36), resource_type text NOT NULL,
  filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=20971520),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,dataset_id,job_id,ordinal),
  FOREIGN KEY(workspace_id,dataset_id,job_id) REFERENCES bi.jobs
);
CREATE TABLE bi.job_outputs (
  workspace_id text NOT NULL, dataset_id text NOT NULL, job_id text NOT NULL,
  resource_type text NOT NULL, content bytea NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,dataset_id,job_id,resource_type),
  FOREIGN KEY(workspace_id,dataset_id,job_id) REFERENCES bi.jobs
);

ALTER TABLE bi.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY own_job ON bi.jobs USING
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true)
   AND actor_id=current_setting('shopgate.actor_id',true)) WITH CHECK
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true)
   AND actor_id=current_setting('shopgate.actor_id',true));
CREATE POLICY queue_worker ON bi.jobs TO shopgate_bi_worker USING (true) WITH CHECK (true);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['job_files','job_outputs'] LOOP
    EXECUTE format('ALTER TABLE bi.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE bi.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY own_job ON bi.%I USING
      (workspace_id=current_setting(''shopgate.workspace_id'',true)
       AND dataset_id=current_setting(''shopgate.dataset_id'',true)
       AND EXISTS(SELECT 1 FROM bi.jobs j WHERE j.workspace_id=%I.workspace_id
         AND j.dataset_id=%I.dataset_id AND j.job_id=%I.job_id
         AND j.actor_id=current_setting(''shopgate.actor_id'',true)))',t,t,t,t);
    EXECUTE format('CREATE POLICY queue_worker ON bi.%I TO shopgate_bi_worker USING(true) WITH CHECK(true)',t);
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bi.%I
      FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation()',t);
  END LOOP;
END; $$;

CREATE FUNCTION bi.protect_job_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.workspace_id,NEW.dataset_id,NEW.job_id,NEW.actor_id,NEW.kind,NEW.base_version,
      NEW.idempotency_key,NEW.request_hash,NEW.payload,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.workspace_id,OLD.dataset_id,OLD.job_id,OLD.actor_id,OLD.kind,OLD.base_version,
      OLD.idempotency_key,OLD.request_hash,OLD.payload,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Job input is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
      AND NOT(OLD.state='awaiting_auth' AND NEW.state='queued') THEN
    RAISE EXCEPTION 'Session renewal requires explicit reauthorization' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER job_input_immutable BEFORE UPDATE ON bi.jobs
  FOR EACH ROW EXECUTE FUNCTION bi.protect_job_input();
CREATE TRIGGER job_history_no_delete BEFORE DELETE ON bi.jobs
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();

-- Installer separately grants the NOLOGIN group to the dedicated worker login.
-- The group can dispatch jobs, but receives no all-dataset policy on trading tables.
GRANT USAGE ON SCHEMA bi TO shopgate_bi_worker;
GRANT SELECT,INSERT,UPDATE ON bi.jobs TO shopgate_bi_worker;
GRANT SELECT,INSERT ON bi.job_files,bi.job_outputs TO shopgate_bi_worker;
