-- Explicit, planned reclamation of expired private payloads only. No startup cleanup.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['shopgate_bi_maintenance','shopgate_bi_retention_executor'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',r);
    ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Unsafe existing BI maintenance group';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
      WHERE r.rolname='shopgate_bi_retention_executor') THEN
    RAISE EXCEPTION 'Retention executor must have no inheriting members';
  END IF;
END; $$;

CREATE TABLE bi.retention_plans (
  plan_id text PRIMARY KEY, operator_role text NOT NULL,
  workspace_id text NOT NULL, dataset_id text NOT NULL,
  object_limit integer NOT NULL CHECK(object_limit BETWEEN 1 AND 100),
  inventory jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  FOREIGN KEY(workspace_id,dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.retention_receipts (
  plan_id text PRIMARY KEY REFERENCES bi.retention_plans,
  operator_role text NOT NULL, digest text NOT NULL,
  removed_files bigint NOT NULL, removed_outputs bigint NOT NULL, removed_rows bigint NOT NULL,
  expired_workers bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE bi.retention_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.retention_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE bi.retention_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.retention_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_executor ON bi.retention_plans TO shopgate_bi_retention_executor
  USING(true) WITH CHECK(true);
CREATE POLICY maintenance_executor ON bi.retention_receipts TO shopgate_bi_retention_executor
  USING(true) WITH CHECK(true);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bi.retention_plans
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bi.retention_receipts
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();

-- Only a non-inheritable definer can delete these three temporary payload types.
-- The generic trading-history/audit trigger remains unchanged.
CREATE FUNCTION bi.protect_private_payload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user='shopgate_bi_retention_executor'
      AND TG_TABLE_SCHEMA='bi' AND TG_TABLE_NAME IN('job_files','job_outputs','import_rows') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Private payload is immutable outside planned retention' USING ERRCODE='23514';
END; $$;
DROP TRIGGER immutable ON bi.job_files;
DROP TRIGGER immutable ON bi.job_outputs;
DROP TRIGGER import_rows_immutable ON bi.import_rows;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bi.job_files
  FOR EACH ROW EXECUTE FUNCTION bi.protect_private_payload();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bi.job_outputs
  FOR EACH ROW EXECUTE FUNCTION bi.protect_private_payload();
CREATE TRIGGER import_rows_immutable BEFORE UPDATE OR DELETE ON bi.import_rows
  FOR EACH ROW EXECUTE FUNCTION bi.protect_private_payload();

GRANT USAGE ON SCHEMA bi TO shopgate_bi_maintenance,shopgate_bi_retention_executor;
GRANT SELECT ON bi.datasets,bi.operation_previews,bi.import_batches,bi.import_rows,
  bi.jobs,bi.job_files,bi.job_outputs TO shopgate_bi_retention_executor;
-- PostgreSQL requires UPDATE on at least one column to acquire a row lock.
-- This NOLOGIN role has no members and none of its functions updates these tables.
GRANT UPDATE(name) ON bi.datasets TO shopgate_bi_retention_executor;
GRANT UPDATE(consumed_at) ON bi.operation_previews TO shopgate_bi_retention_executor;
GRANT UPDATE(row_count) ON bi.import_batches TO shopgate_bi_retention_executor;
GRANT UPDATE(stage) ON bi.jobs TO shopgate_bi_retention_executor;
GRANT UPDATE(state,error_code,lease_owner,lease_until,updated_at) ON bi.jobs
  TO shopgate_bi_retention_executor;
GRANT DELETE ON bi.job_files,bi.job_outputs,bi.import_rows TO shopgate_bi_retention_executor;
GRANT SELECT,INSERT ON bi.retention_plans,bi.retention_receipts TO shopgate_bi_retention_executor;
CREATE POLICY retention_executor ON bi.jobs TO shopgate_bi_retention_executor USING(true);
CREATE POLICY retention_executor ON bi.job_files TO shopgate_bi_retention_executor USING(true);
CREATE POLICY retention_executor ON bi.job_outputs TO shopgate_bi_retention_executor USING(true);

CREATE FUNCTION bi.retention_inventory(w text,d text,n integer) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,bi SET timezone='UTC' AS $$
  SELECT jsonb_build_object(
    'jobs',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.expires_at,s.job_id) FROM (
      SELECT j.job_id,j.expires_at,j.state,j.lease_until,
        (SELECT count(*) FROM bi.job_files f WHERE f.job_id=j.job_id) AS files,
        (SELECT coalesce(sum(octet_length(f.content)),0) FROM bi.job_files f
          WHERE f.job_id=j.job_id) AS file_bytes,
        (SELECT count(*) FROM bi.job_outputs o WHERE o.job_id=j.job_id) AS outputs,
        (SELECT coalesce(sum(octet_length(o.content)),0) FROM bi.job_outputs o
          WHERE o.job_id=j.job_id) AS output_bytes
      FROM bi.jobs j WHERE j.workspace_id=w AND j.dataset_id=d
        AND j.expires_at<=clock_timestamp()
        AND (j.state<>'running' OR j.lease_until<=clock_timestamp())
        AND (EXISTS(SELECT 1 FROM bi.job_files f WHERE f.job_id=j.job_id)
          OR EXISTS(SELECT 1 FROM bi.job_outputs o WHERE o.job_id=j.job_id) OR j.state='running')
      ORDER BY j.expires_at,j.job_id LIMIT n
    ) s),'[]'::jsonb),
    'batches',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.expires_at,s.batch_id) FROM (
      SELECT b.batch_id,b.preview_id,b.expires_at,
        (SELECT count(*) FROM bi.import_rows r WHERE r.workspace_id=w AND r.dataset_id=d
          AND r.batch_id=b.batch_id) AS rows,
        (SELECT coalesce(sum(octet_length(convert_to(r.record::text,'UTF8'))),0)
          FROM bi.import_rows r WHERE r.workspace_id=w AND r.dataset_id=d
          AND r.batch_id=b.batch_id) AS row_bytes
      FROM bi.import_batches b WHERE b.workspace_id=w AND b.dataset_id=d
        AND b.expires_at<=clock_timestamp()
        AND EXISTS(SELECT 1 FROM bi.import_rows r WHERE r.workspace_id=w AND r.dataset_id=d
          AND r.batch_id=b.batch_id)
        AND NOT EXISTS(SELECT 1 FROM bi.operation_previews p WHERE p.workspace_id=w
          AND p.dataset_id=d AND p.preview_id=b.preview_id AND p.consumed_at IS NULL
          AND p.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM bi.jobs j WHERE j.workspace_id=w AND j.dataset_id=d
          AND j.state='running' AND j.kind='confirm_import'
          AND j.payload->'parameters'->>'preview_id'=b.preview_id)
      ORDER BY b.expires_at,b.batch_id LIMIT n
    ) s),'[]'::jsonb)
  )
$$;

CREATE FUNCTION bi.plan_private_retention(w text,d text,n integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,bi SET timezone='UTC' AS $$
DECLARE p text; content jsonb; hash text; deadline timestamptz;
BEGIN
  IF w IS NULL OR d IS NULL OR w !~ '^[A-Za-z0-9_.:-]{1,120}$'
      OR d !~ '^[A-Za-z0-9_.:-]{1,120}$' OR n IS NULL OR n NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid retention range' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('shopgate.workspace_id',w,true),set_config('shopgate.dataset_id',d,true);
  IF NOT EXISTS(SELECT 1 FROM bi.datasets WHERE workspace_id=w AND dataset_id=d) THEN
    RAISE EXCEPTION 'Unknown retention dataset' USING ERRCODE='22023';
  END IF;
  content:=bi.retention_inventory(w,d,n);
  p:=gen_random_uuid()::text;
  hash:=encode(sha256(convert_to(jsonb_build_object('workspace_id',w,'dataset_id',d,
    'operator_role',session_user,'inventory',content,'plan_id',p)::text,'UTF8')),'hex');
  INSERT INTO bi.retention_plans(plan_id,operator_role,workspace_id,dataset_id,object_limit,
      inventory,digest) VALUES(p,session_user,w,d,n,content,hash) RETURNING expires_at INTO deadline;
  RETURN jsonb_build_object('plan_id',p,'workspace_id',w,'dataset_id',d,'inventory',content,
    'digest',hash,'expires_at',deadline);
END; $$;

CREATE FUNCTION bi.apply_private_retention(p text,confirmed_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,bi SET timezone='UTC' AS $$
DECLARE plan bi.retention_plans%ROWTYPE; receipt bi.retention_receipts%ROWTYPE;
  candidate record; actual jsonb; files bigint; outputs bigint; source_rows bigint; abandoned bigint;
  expected_files bigint; expected_outputs bigint; expected_rows bigint;
BEGIN
  SELECT * INTO plan FROM bi.retention_plans WHERE plan_id=p;
  IF NOT FOUND OR confirmed_digest IS DISTINCT FROM plan.digest
      OR plan.operator_role<>session_user THEN
    RAISE EXCEPTION 'Invalid retention confirmation' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('shopgate.bi.retention'),hashtext(p));
  SELECT * INTO receipt FROM bi.retention_receipts WHERE plan_id=p;
  IF FOUND THEN RETURN to_jsonb(receipt); END IF;
  IF plan.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Retention plan expired; review again' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('shopgate.workspace_id',plan.workspace_id,true),
    set_config('shopgate.dataset_id',plan.dataset_id,true);
  -- Same order as confirm_operation -> confirm_import -> final job fence.
  PERFORM 1 FROM bi.datasets WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
    FOR UPDATE;
  PERFORM 1 FROM bi.operation_previews WHERE workspace_id=plan.workspace_id
    AND dataset_id=plan.dataset_id AND preview_id IN
      (SELECT value->>'preview_id' FROM jsonb_array_elements(plan.inventory->'batches'))
    ORDER BY preview_id FOR UPDATE;
  PERFORM 1 FROM bi.import_batches WHERE workspace_id=plan.workspace_id
    AND dataset_id=plan.dataset_id AND batch_id IN
      (SELECT value->>'batch_id' FROM jsonb_array_elements(plan.inventory->'batches'))
    ORDER BY batch_id FOR UPDATE;
  FOR candidate IN SELECT value->>'job_id' AS id
      FROM jsonb_array_elements(plan.inventory->'jobs') ORDER BY id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext('shopgate.bi.jobs'),hashtext(candidate.id)) THEN
      RAISE EXCEPTION 'Worker still owns payload; review again' USING ERRCODE='40001';
    END IF;
  END LOOP;
  PERFORM 1 FROM bi.jobs WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
    AND job_id IN (SELECT value->>'job_id' FROM jsonb_array_elements(plan.inventory->'jobs'))
    ORDER BY job_id FOR NO KEY UPDATE;
  actual:=bi.retention_inventory(plan.workspace_id,plan.dataset_id,plan.object_limit);
  IF actual IS DISTINCT FROM plan.inventory THEN
    RAISE EXCEPTION 'Retention inventory changed; review again' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(sum((value->>'files')::bigint),0),coalesce(sum((value->>'outputs')::bigint),0)
    INTO expected_files,expected_outputs FROM jsonb_array_elements(actual->'jobs');
  SELECT coalesce(sum((value->>'rows')::bigint),0) INTO expected_rows
    FROM jsonb_array_elements(actual->'batches');
  DELETE FROM bi.job_files WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
    AND job_id IN (SELECT value->>'job_id' FROM jsonb_array_elements(actual->'jobs'));
  GET DIAGNOSTICS files=ROW_COUNT;
  DELETE FROM bi.job_outputs WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
    AND job_id IN (SELECT value->>'job_id' FROM jsonb_array_elements(actual->'jobs'));
  GET DIAGNOSTICS outputs=ROW_COUNT;
  DELETE FROM bi.import_rows WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
    AND batch_id IN (SELECT value->>'batch_id' FROM jsonb_array_elements(actual->'batches'));
  GET DIAGNOSTICS source_rows=ROW_COUNT;
  IF (files,outputs,source_rows) IS DISTINCT FROM
      (expected_files,expected_outputs,expected_rows) THEN
    RAISE EXCEPTION 'Payload changed concurrently; no cleanup committed' USING ERRCODE='40001';
  END IF;
  -- Only after obtaining the same advisory lock as the real worker. An abandoned
  -- expired worker is settled explicitly; a live worker can never be interrupted.
  UPDATE bi.jobs SET state='failed',stage='failed',error_code='BI_JOB_EXPIRED',
    lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=plan.workspace_id AND dataset_id=plan.dataset_id
      AND job_id IN (SELECT value->>'job_id' FROM jsonb_array_elements(actual->'jobs'))
      AND state='running' AND expires_at<=clock_timestamp() AND lease_until<=clock_timestamp();
  GET DIAGNOSTICS abandoned=ROW_COUNT;
  INSERT INTO bi.retention_receipts(plan_id,operator_role,digest,removed_files,removed_outputs,
      removed_rows,expired_workers) VALUES(p,session_user,plan.digest,files,outputs,source_rows,abandoned)
    RETURNING * INTO receipt;
  RETURN to_jsonb(receipt);
END; $$;

-- The executor cannot be inherited/SET ROLE'd by maintenance, API or workers.
-- Definer functions are the only route; all other caller privileges are revoked.
GRANT CREATE ON SCHEMA bi TO shopgate_bi_retention_executor;
ALTER FUNCTION bi.retention_inventory(text,text,integer) OWNER TO shopgate_bi_retention_executor;
ALTER FUNCTION bi.plan_private_retention(text,text,integer) OWNER TO shopgate_bi_retention_executor;
ALTER FUNCTION bi.apply_private_retention(text,text) OWNER TO shopgate_bi_retention_executor;
REVOKE CREATE ON SCHEMA bi FROM shopgate_bi_retention_executor;
REVOKE ALL ON FUNCTION bi.retention_inventory(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION bi.plan_private_retention(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION bi.apply_private_retention(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bi.plan_private_retention(text,text,integer),
  bi.apply_private_retention(text,text) TO shopgate_bi_maintenance;
REVOKE ALL ON bi.retention_plans,bi.retention_receipts FROM PUBLIC;
