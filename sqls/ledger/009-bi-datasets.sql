-- Metadata-only workspace directory; fact RLS from006 remains unchanged.
CREATE TABLE bi.dataset_directory (
  workspace_id text NOT NULL, dataset_id text NOT NULL,
  name text NOT NULL, source_kind text NOT NULL CHECK(source_kind IN ('demo','import')),
  version bigint NOT NULL CHECK(version>0), reporting_currency text NOT NULL,
  state text NOT NULL CHECK(state IN ('active','archived')), updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,dataset_id),
  FOREIGN KEY(workspace_id,dataset_id) REFERENCES bi.datasets
);
-- Explicit migration only. No runtime startup backfill or source replacement.
INSERT INTO bi.dataset_directory
  SELECT workspace_id,dataset_id,name,source_kind,version,reporting_currency,state,updated_at
  FROM bi.datasets;
ALTER TABLE bi.dataset_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.dataset_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_read ON bi.dataset_directory FOR SELECT USING
  (workspace_id=current_setting('shopgate.workspace_id',true));
CREATE POLICY directory_insert ON bi.dataset_directory FOR INSERT WITH CHECK
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true));
CREATE POLICY directory_update ON bi.dataset_directory FOR UPDATE USING
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true)) WITH CHECK
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true));
-- No DELETE policy. Normal roles cannot delete directory entries even with a grant.
CREATE FUNCTION bi.sync_dataset_directory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bi.dataset_directory VALUES
    (NEW.workspace_id,NEW.dataset_id,NEW.name,NEW.source_kind,NEW.version,
     NEW.reporting_currency,NEW.state,NEW.updated_at)
  ON CONFLICT(workspace_id,dataset_id) DO UPDATE SET
    name=EXCLUDED.name,source_kind=EXCLUDED.source_kind,version=EXCLUDED.version,
    reporting_currency=EXCLUDED.reporting_currency,state=EXCLUDED.state,
    updated_at=EXCLUDED.updated_at;
  RETURN NEW;
END; $$;
-- SECURITY INVOKER: runtime still uses its scoped non-superuser role.
CREATE TRIGGER dataset_directory_sync AFTER INSERT OR UPDATE ON bi.datasets
  FOR EACH ROW EXECUTE FUNCTION bi.sync_dataset_directory();

CREATE FUNCTION bi.protect_dataset_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.workspace_id,NEW.dataset_id,NEW.source_kind,NEW.reporting_currency)
      IS DISTINCT FROM (OLD.workspace_id,OLD.dataset_id,OLD.source_kind,OLD.reporting_currency) THEN
    RAISE EXCEPTION 'Dataset identity, origin and reporting currency are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dataset_origin_immutable BEFORE UPDATE ON bi.datasets
  FOR EACH ROW EXECUTE FUNCTION bi.protect_dataset_origin();

CREATE TABLE bi.dataset_creations (
  workspace_id text NOT NULL, idempotency_key text NOT NULL, actor_id text NOT NULL,
  dataset_id text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,dataset_id) REFERENCES bi.datasets
);
ALTER TABLE bi.dataset_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.dataset_creations FORCE ROW LEVEL SECURITY;
CREATE POLICY creation_read ON bi.dataset_creations FOR SELECT USING
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND actor_id=current_setting('shopgate.actor_id',true));
CREATE POLICY creation_insert ON bi.dataset_creations FOR INSERT WITH CHECK
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND actor_id=current_setting('shopgate.actor_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true));
CREATE TRIGGER dataset_creation_immutable BEFORE UPDATE OR DELETE ON bi.dataset_creations
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();
