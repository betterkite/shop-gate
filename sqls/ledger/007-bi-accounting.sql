-- Forward migration; never alter applied 006 checksum.
ALTER TABLE bi.line_snapshots
  ADD COLUMN revenue_fx_source text,
  ADD COLUMN cost_fx_source text,
  ADD COLUMN missing_reasons jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(missing_reasons) = 'array');

CREATE TABLE bi.expense_snapshots (
  workspace_id text NOT NULL, dataset_id text NOT NULL, expense_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  amount_cny bi.money, fx_rate bi.fx_rate, fx_source text,
  accounting_status text NOT NULL CHECK (accounting_status IN
    ('allocated', 'unallocated', 'missing_fx', 'missing_weight')),
  allocated_lines bigint NOT NULL CHECK (allocated_lines >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, expense_id, revision),
  FOREIGN KEY (workspace_id, dataset_id, expense_id) REFERENCES bi.expenses,
  CHECK ((accounting_status = 'missing_fx' AND amount_cny IS NULL AND fx_rate IS NULL)
      OR (accounting_status <> 'missing_fx' AND amount_cny IS NOT NULL AND fx_rate IS NOT NULL))
);
CREATE TABLE bi.accounting_runs (
  workspace_id text NOT NULL, dataset_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  algorithm_version text NOT NULL,
  processed_lines bigint NOT NULL CHECK (processed_lines >= 0),
  processed_expenses bigint NOT NULL CHECK (processed_expenses >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, revision),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);

-- Revenue weighting can exceed quantity's magnitude; keep exact, finite original weights.
ALTER TABLE bi.expense_allocations ALTER COLUMN weight TYPE numeric USING weight::numeric;
ALTER TABLE bi.expense_allocations ADD CONSTRAINT allocation_weight_exact
  CHECK (weight::text NOT IN ('NaN','Infinity','-Infinity')
         AND weight > 0 AND scale(weight) <= 4 AND weight < 10000000000000000);

CREATE FUNCTION bi.protect_cost_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'valid_to') IS DISTINCT FROM (to_jsonb(OLD) - 'valid_to') THEN
    RAISE EXCEPTION 'Cost facts are versioned, not overwritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cost_fact_immutable BEFORE UPDATE ON bi.cost_versions
  FOR EACH ROW EXECUTE FUNCTION bi.protect_cost_fact();

CREATE TRIGGER expense_snapshot_immutable BEFORE UPDATE OR DELETE ON bi.expense_snapshots
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();
CREATE TRIGGER expense_allocation_immutable BEFORE UPDATE OR DELETE ON bi.expense_allocations
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();
CREATE TRIGGER accounting_run_immutable BEFORE UPDATE OR DELETE ON bi.accounting_runs
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();

DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['expense_snapshots','accounting_runs'] LOOP
    EXECUTE format('ALTER TABLE bi.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE bi.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('CREATE POLICY dataset_scope ON bi.%I USING '
      || '(workspace_id = current_setting(''shopgate.workspace_id'', true) '
      || 'AND dataset_id = current_setting(''shopgate.dataset_id'', true)) WITH CHECK '
      || '(workspace_id = current_setting(''shopgate.workspace_id'', true) '
      || 'AND dataset_id = current_setting(''shopgate.dataset_id'', true))', relation_name);
  END LOOP;
END; $$;
