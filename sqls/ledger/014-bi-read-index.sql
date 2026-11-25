-- Derived, replaceable read index. Original order, cost, refund and fee records stay authoritative.
CREATE TABLE bi.read_index (
  workspace_id text NOT NULL, dataset_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  format_version integer NOT NULL, first_day date NOT NULL, last_day date NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.read_index_parts (
  workspace_id text NOT NULL, dataset_id text NOT NULL, basis text NOT NULL CHECK (basis IN ('payment','occurred')),
  business_day date NOT NULL, is_marker boolean NOT NULL, part integer NOT NULL CHECK(part >= 0),
  generation bigint NOT NULL CHECK(generation > 0), payload bytea NOT NULL,
  PRIMARY KEY (workspace_id,dataset_id,basis,business_day,is_marker,part),
  FOREIGN KEY (workspace_id,dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.overview_index_parts (
  LIKE bi.read_index_parts INCLUDING ALL,
  FOREIGN KEY (workspace_id,dataset_id) REFERENCES bi.datasets,
  CHECK (NOT is_marker)
);
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['read_index','read_index_parts','overview_index_parts'] LOOP
    EXECUTE format('ALTER TABLE bi.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE bi.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY dataset_scope ON bi.%I USING '
      || '(workspace_id=current_setting(''shopgate.workspace_id'',true) '
      || 'AND dataset_id=current_setting(''shopgate.dataset_id'',true)) WITH CHECK '
      || '(workspace_id=current_setting(''shopgate.workspace_id'',true) '
      || 'AND dataset_id=current_setting(''shopgate.dataset_id'',true))',tbl);
  END LOOP;
END $$;

-- Upgrade roles that already have access to the complete source ledger. A directory
-- reader or a role restricted to individual tables must not acquire posting evidence.
DO $$
DECLARE actor record;
BEGIN
  FOR actor IN
    SELECT DISTINCT role.oid, role.rolname FROM pg_class src
    CROSS JOIN LATERAL aclexplode(src.relacl) AS grant_row
    JOIN pg_roles role ON role.oid=grant_row.grantee
    WHERE src.oid='bi.line_snapshots'::regclass AND src.relowner<>role.oid
      AND grant_row.privilege_type='SELECT'
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['channels','stores','products','skus','listings',
          'orders','order_lines','refunds','expenses','expense_snapshots','expense_allocations'])
          AS facts(name) WHERE NOT has_table_privilege(role.oid,format('bi.%I',facts.name),'SELECT'))
  LOOP
    EXECUTE format('GRANT SELECT ON bi.read_index,bi.read_index_parts,bi.overview_index_parts TO %I',actor.rolname);
    IF has_table_privilege(actor.oid,'bi.accounting_runs','INSERT')
       AND has_table_privilege(actor.oid,'bi.datasets','UPDATE') THEN
      EXECUTE format('GRANT INSERT,UPDATE ON bi.read_index,bi.read_index_parts,bi.overview_index_parts TO %I',actor.rolname);
    END IF;
  END LOOP;
END $$;
