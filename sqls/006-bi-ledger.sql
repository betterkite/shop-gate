-- Independent v0.1 transaction ledger. Never converts old behavior estimates into orders.
-- Run through ledger.migrations; DDL, checksum and revision are committed together.
CREATE SCHEMA IF NOT EXISTS bi;

CREATE DOMAIN bi.money AS numeric
  CHECK (VALUE::text NOT IN ('NaN', 'Infinity', '-Infinity')
         AND scale(VALUE) <= 2 AND abs(VALUE) < 10000000000000000);
CREATE DOMAIN bi.quantity AS numeric
  CHECK (VALUE::text NOT IN ('NaN', 'Infinity', '-Infinity')
         AND scale(VALUE) <= 4 AND abs(VALUE) < 1000000000000);
CREATE DOMAIN bi.unit_cost AS numeric
  CHECK (VALUE::text NOT IN ('NaN', 'Infinity', '-Infinity')
         AND scale(VALUE) <= 4 AND VALUE >= 0 AND VALUE < 1000000000000);
CREATE DOMAIN bi.fx_rate AS numeric
  CHECK (VALUE::text NOT IN ('NaN', 'Infinity', '-Infinity')
         AND scale(VALUE) <= 8 AND VALUE > 0 AND VALUE < 100000000);

CREATE TABLE bi.workspaces (
  workspace_id text PRIMARY KEY CHECK (length(workspace_id) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE bi.datasets (
  workspace_id text NOT NULL REFERENCES bi.workspaces(workspace_id),
  dataset_id text NOT NULL CHECK (length(dataset_id) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  source_kind text NOT NULL CHECK (source_kind IN ('demo', 'import')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reporting_currency text NOT NULL DEFAULT 'CNY' CHECK (reporting_currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id)
);
CREATE TABLE bi.channels (
  workspace_id text NOT NULL, dataset_id text NOT NULL, channel_id text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id, channel_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.stores (
  workspace_id text NOT NULL, dataset_id text NOT NULL, store_id text NOT NULL,
  channel_id text NOT NULL, name text NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id, store_id),
  UNIQUE (workspace_id, dataset_id, store_id, channel_id),
  FOREIGN KEY (workspace_id, dataset_id, channel_id) REFERENCES bi.channels
);
CREATE TABLE bi.products (
  workspace_id text NOT NULL, dataset_id text NOT NULL, product_id text NOT NULL,
  name text NOT NULL, category text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, dataset_id, product_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.skus (
  workspace_id text NOT NULL, dataset_id text NOT NULL, sku_id text NOT NULL,
  product_id text NOT NULL, name text NOT NULL, unit text NOT NULL DEFAULT '件',
  PRIMARY KEY (workspace_id, dataset_id, sku_id),
  FOREIGN KEY (workspace_id, dataset_id, product_id) REFERENCES bi.products
);
CREATE TABLE bi.listings (
  workspace_id text NOT NULL, dataset_id text NOT NULL, listing_id text NOT NULL,
  store_id text NOT NULL, platform_sku_id text NOT NULL, name text NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id, listing_id),
  UNIQUE (workspace_id, dataset_id, store_id, platform_sku_id),
  UNIQUE (workspace_id, dataset_id, listing_id, store_id),
  FOREIGN KEY (workspace_id, dataset_id, store_id) REFERENCES bi.stores
);
CREATE TABLE bi.mappings (
  workspace_id text NOT NULL, dataset_id text NOT NULL, mapping_id text NOT NULL,
  listing_id text NOT NULL, sku_id text NOT NULL,
  unit_multiplier bi.quantity NOT NULL CHECK (unit_multiplier > 0),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  created_version bigint NOT NULL CHECK (created_version > 0),
  PRIMARY KEY (workspace_id, dataset_id, mapping_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  FOREIGN KEY (workspace_id, dataset_id, listing_id) REFERENCES bi.listings,
  FOREIGN KEY (workspace_id, dataset_id, sku_id) REFERENCES bi.skus
);
CREATE INDEX mappings_lookup ON bi.mappings
  (workspace_id, dataset_id, listing_id, valid_from DESC);
CREATE TABLE bi.fx_rates (
  workspace_id text NOT NULL, dataset_id text NOT NULL, rate_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_date date NOT NULL, rate bi.fx_rate NOT NULL, source text NOT NULL,
  PRIMARY KEY (workspace_id, dataset_id, rate_id),
  UNIQUE (workspace_id, dataset_id, currency, rate_date),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.cost_versions (
  workspace_id text NOT NULL, dataset_id text NOT NULL, cost_id text NOT NULL,
  sku_id text NOT NULL, level text NOT NULL CHECK (level IN ('base', 'channel', 'store')),
  channel_id text, store_id text,
  unit_cost bi.unit_cost NOT NULL, currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  source text NOT NULL, created_version bigint NOT NULL CHECK (created_version > 0),
  PRIMARY KEY (workspace_id, dataset_id, cost_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((level = 'base' AND channel_id IS NULL AND store_id IS NULL)
      OR (level = 'channel' AND channel_id IS NOT NULL AND store_id IS NULL)
      OR (level = 'store' AND channel_id IS NOT NULL AND store_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, dataset_id, sku_id) REFERENCES bi.skus,
  FOREIGN KEY (workspace_id, dataset_id, channel_id) REFERENCES bi.channels,
  FOREIGN KEY (workspace_id, dataset_id, store_id, channel_id) REFERENCES bi.stores
);
CREATE INDEX cost_versions_lookup ON bi.cost_versions
  (workspace_id, dataset_id, sku_id, valid_from DESC);
CREATE TABLE bi.orders (
  workspace_id text NOT NULL, dataset_id text NOT NULL, order_id text NOT NULL,
  store_id text NOT NULL, paid_at timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('paid', 'cancelled')),
  PRIMARY KEY (workspace_id, dataset_id, order_id),
  UNIQUE (workspace_id, dataset_id, order_id, store_id),
  FOREIGN KEY (workspace_id, dataset_id, store_id) REFERENCES bi.stores
);
CREATE INDEX orders_scope_paid ON bi.orders (workspace_id, dataset_id, paid_at, store_id);
CREATE TABLE bi.order_lines (
  workspace_id text NOT NULL, dataset_id text NOT NULL, line_id text NOT NULL,
  order_id text NOT NULL, store_id text NOT NULL, listing_id text NOT NULL,
  quantity bi.quantity NOT NULL CHECK (quantity > 0),
  paid_amount bi.money NOT NULL CHECK (paid_amount >= 0),
  PRIMARY KEY (workspace_id, dataset_id, line_id),
  FOREIGN KEY (workspace_id, dataset_id, order_id, store_id) REFERENCES bi.orders
    DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (workspace_id, dataset_id, listing_id, store_id) REFERENCES bi.listings
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE bi.line_snapshots (
  workspace_id text NOT NULL, dataset_id text NOT NULL, line_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mapping_id text, sku_id text, unit_multiplier bi.quantity,
  standard_quantity bi.quantity, cost_id text, unit_cost bi.unit_cost,
  revenue_fx_rate bi.fx_rate, cost_fx_rate bi.fx_rate,
  revenue_cny bi.money, cost_cny bi.money,
  accounting_status text NOT NULL CHECK (accounting_status IN
    ('complete', 'missing_mapping', 'missing_cost', 'missing_fx')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, line_id, revision),
  CHECK (unit_multiplier IS NULL OR unit_multiplier > 0),
  CHECK (standard_quantity IS NULL OR standard_quantity > 0),
  CHECK (accounting_status <> 'complete' OR
    (mapping_id IS NOT NULL AND sku_id IS NOT NULL AND cost_id IS NOT NULL
     AND unit_multiplier IS NOT NULL AND standard_quantity IS NOT NULL
     AND unit_cost IS NOT NULL AND revenue_fx_rate IS NOT NULL
     AND cost_fx_rate IS NOT NULL AND revenue_cny IS NOT NULL AND cost_cny IS NOT NULL)),
  FOREIGN KEY (workspace_id, dataset_id, line_id) REFERENCES bi.order_lines,
  FOREIGN KEY (workspace_id, dataset_id, mapping_id) REFERENCES bi.mappings,
  FOREIGN KEY (workspace_id, dataset_id, sku_id) REFERENCES bi.skus,
  FOREIGN KEY (workspace_id, dataset_id, cost_id) REFERENCES bi.cost_versions
);
CREATE TABLE bi.refunds (
  workspace_id text NOT NULL, dataset_id text NOT NULL, refund_id text NOT NULL,
  line_id text NOT NULL, occurred_at timestamptz NOT NULL,
  amount bi.money NOT NULL CHECK (amount > 0),
  refund_type text NOT NULL CHECK (refund_type IN ('refund_only', 'return')),
  returned_quantity bi.quantity NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  recoverable_quantity bi.quantity NOT NULL DEFAULT 0
    CHECK (recoverable_quantity >= 0 AND recoverable_quantity <= returned_quantity),
  reason text NOT NULL DEFAULT '', status text NOT NULL CHECK (status IN ('completed', 'pending')),
  PRIMARY KEY (workspace_id, dataset_id, refund_id),
  CHECK (refund_type <> 'refund_only' OR (returned_quantity = 0 AND recoverable_quantity = 0)),
  FOREIGN KEY (workspace_id, dataset_id, line_id) REFERENCES bi.order_lines
);
CREATE INDEX refunds_scope_date ON bi.refunds (workspace_id, dataset_id, occurred_at, line_id);
CREATE TABLE bi.expenses (
  workspace_id text NOT NULL, dataset_id text NOT NULL, expense_id text NOT NULL,
  occurred_at timestamptz NOT NULL, store_id text, channel_id text,
  line_id text, amount bi.money NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expense_type text NOT NULL CHECK (expense_type IN
    ('platform', 'packaging', 'logistics', 'advertising', 'other')),
  allocation_method text NOT NULL CHECK (allocation_method IN
    ('direct', 'revenue', 'quantity', 'unallocated')),
  source text NOT NULL, note text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, dataset_id, expense_id),
  CHECK (store_id IS NULL OR channel_id IS NOT NULL),
  CHECK (allocation_method <> 'direct' OR line_id IS NOT NULL),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets,
  FOREIGN KEY (workspace_id, dataset_id, channel_id) REFERENCES bi.channels,
  FOREIGN KEY (workspace_id, dataset_id, store_id, channel_id) REFERENCES bi.stores,
  FOREIGN KEY (workspace_id, dataset_id, line_id) REFERENCES bi.order_lines
);
CREATE TABLE bi.expense_allocations (
  workspace_id text NOT NULL, dataset_id text NOT NULL, expense_id text NOT NULL,
  line_id text NOT NULL, revision bigint NOT NULL CHECK (revision > 0),
  amount_cny bi.money NOT NULL, weight bi.quantity NOT NULL CHECK (weight > 0),
  PRIMARY KEY (workspace_id, dataset_id, expense_id, line_id, revision),
  FOREIGN KEY (workspace_id, dataset_id, expense_id) REFERENCES bi.expenses,
  FOREIGN KEY (workspace_id, dataset_id, line_id) REFERENCES bi.order_lines
);
CREATE TABLE bi.targets (
  workspace_id text NOT NULL, dataset_id text NOT NULL, store_id text NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  sales_target bi.money NOT NULL CHECK (sales_target >= 0),
  profit_target bi.money,
  PRIMARY KEY (workspace_id, dataset_id, store_id, month),
  FOREIGN KEY (workspace_id, dataset_id, store_id) REFERENCES bi.stores
);
CREATE TABLE bi.saved_views (
  workspace_id text NOT NULL, dataset_id text NOT NULL, view_id text NOT NULL,
  actor_id text NOT NULL, name text NOT NULL, report_type text NOT NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, view_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.import_batches (
  workspace_id text NOT NULL, dataset_id text NOT NULL, batch_id text NOT NULL,
  actor_id text NOT NULL, resource_type text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('preview', 'committed', 'rejected')),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  error_count bigint NOT NULL CHECK (error_count >= 0),
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, batch_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.operation_previews (
  workspace_id text NOT NULL, dataset_id text NOT NULL, preview_id text NOT NULL,
  actor_id text NOT NULL, kind text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  impact jsonb NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  PRIMARY KEY (workspace_id, dataset_id, preview_id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES bi.datasets
);
CREATE TABLE bi.operations (
  workspace_id text NOT NULL, dataset_id text NOT NULL, idempotency_key text NOT NULL,
  actor_id text NOT NULL, preview_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL, committed_version bigint NOT NULL CHECK (committed_version > 0),
  PRIMARY KEY (workspace_id, dataset_id, idempotency_key),
  UNIQUE (workspace_id, dataset_id, preview_id),
  FOREIGN KEY (workspace_id, dataset_id, preview_id) REFERENCES bi.operation_previews
);
CREATE TABLE bi.audit_events (
  workspace_id text NOT NULL, dataset_id text NOT NULL, event_id text NOT NULL,
  actor_id text NOT NULL, operation_kind text NOT NULL, preview_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0), summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, event_id),
  FOREIGN KEY (workspace_id, dataset_id, preview_id) REFERENCES bi.operation_previews
);

-- Defence in depth: normal runtime role must be non-superuser / NOBYPASSRLS.
-- Serialize interval changes on the parent row, including concurrent transactions.
CREATE FUNCTION bi.prevent_mapping_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bi.listings WHERE workspace_id = NEW.workspace_id
    AND dataset_id = NEW.dataset_id AND listing_id = NEW.listing_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bi.mappings WHERE workspace_id = NEW.workspace_id
      AND dataset_id = NEW.dataset_id AND listing_id = NEW.listing_id
      AND mapping_id <> NEW.mapping_id
      AND valid_from < coalesce(NEW.valid_to, 'infinity'::timestamptz)
      AND NEW.valid_from < coalesce(valid_to, 'infinity'::timestamptz)) THEN
    RAISE EXCEPTION 'Overlapping mapping intervals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mapping_intervals BEFORE INSERT OR UPDATE ON bi.mappings
  FOR EACH ROW EXECUTE FUNCTION bi.prevent_mapping_overlap();
CREATE FUNCTION bi.prevent_cost_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bi.skus WHERE workspace_id = NEW.workspace_id
    AND dataset_id = NEW.dataset_id AND sku_id = NEW.sku_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bi.cost_versions WHERE workspace_id = NEW.workspace_id
      AND dataset_id = NEW.dataset_id AND sku_id = NEW.sku_id AND level = NEW.level
      AND channel_id IS NOT DISTINCT FROM NEW.channel_id
      AND store_id IS NOT DISTINCT FROM NEW.store_id AND cost_id <> NEW.cost_id
      AND valid_from < coalesce(NEW.valid_to, 'infinity'::timestamptz)
      AND NEW.valid_from < coalesce(valid_to, 'infinity'::timestamptz)) THEN
    RAISE EXCEPTION 'Overlapping cost intervals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_intervals BEFORE INSERT OR UPDATE ON bi.cost_versions
  FOR EACH ROW EXECUTE FUNCTION bi.prevent_cost_overlap();

CREATE FUNCTION bi.check_completed_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_amount numeric; original_quantity numeric;
BEGIN
  SELECT paid_amount, quantity INTO original_amount, original_quantity FROM bi.order_lines
    WHERE workspace_id = NEW.workspace_id AND dataset_id = NEW.dataset_id
      AND line_id = NEW.line_id FOR UPDATE;
  IF NEW.status = 'completed' AND original_amount IS NOT NULL AND EXISTS (
    SELECT 1 FROM (
      SELECT coalesce(sum(amount), 0) AS refunded,
             coalesce(sum(returned_quantity), 0) AS returned
      FROM bi.refunds WHERE workspace_id = NEW.workspace_id AND dataset_id = NEW.dataset_id
        AND line_id = NEW.line_id AND status = 'completed' AND refund_id <> NEW.refund_id
    ) totals WHERE totals.refunded + NEW.amount > original_amount
               OR totals.returned + NEW.returned_quantity > original_quantity
  ) THEN
    RAISE EXCEPTION 'Refund exceeds original payment or platform quantity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_limits BEFORE INSERT OR UPDATE ON bi.refunds
  FOR EACH ROW EXECUTE FUNCTION bi.check_completed_refund();
COMMENT ON COLUMN bi.refunds.returned_quantity IS
  'Original platform sale units; convert with payment snapshot multiplier.';
COMMENT ON COLUMN bi.refunds.recoverable_quantity IS
  'Recoverable platform units; refund_only never implies recovery.';

-- A verified service scope is set only inside the repository transaction.
ALTER TABLE bi.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON bi.workspaces
  USING (workspace_id = current_setting('shopgate.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('shopgate.workspace_id', true));
DO $policies$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'datasets', 'channels', 'stores', 'products', 'skus', 'listings', 'mappings',
    'fx_rates', 'cost_versions', 'orders', 'order_lines', 'line_snapshots', 'refunds',
    'expenses', 'expense_allocations', 'targets', 'saved_views', 'import_batches',
    'operation_previews', 'operations', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE bi.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE bi.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY dataset_scope ON bi.%I USING '
      || '(workspace_id = current_setting(''shopgate.workspace_id'', true) '
      || 'AND dataset_id = current_setting(''shopgate.dataset_id'', true)) '
      || 'WITH CHECK (workspace_id = current_setting(''shopgate.workspace_id'', true) '
      || 'AND dataset_id = current_setting(''shopgate.dataset_id'', true))', tbl);
  END LOOP;
END
$policies$;
