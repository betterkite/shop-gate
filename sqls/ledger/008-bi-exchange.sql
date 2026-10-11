-- Full transaction facts/metadata. Forward only; never rewrites prior checksums.
ALTER TABLE bi.channels ADD COLUMN color text NOT NULL DEFAULT '#0e7490'
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE bi.stores
  ADD COLUMN market text NOT NULL DEFAULT '',
  ADD COLUMN mode text NOT NULL DEFAULT '',
  ADD COLUMN currency text NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE bi.products ADD COLUMN series text NOT NULL DEFAULT '';
ALTER TABLE bi.listings
  ADD COLUMN platform_product_id text NOT NULL DEFAULT '',
  ADD COLUMN unit text NOT NULL DEFAULT '件';
ALTER TABLE bi.orders
  ALTER COLUMN paid_at DROP NOT NULL,
  DROP CONSTRAINT orders_status_check,
  ADD CONSTRAINT orders_status_check CHECK (status IN ('paid','unpaid','cancelled')),
  ADD CONSTRAINT paid_order_time CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  ADD CONSTRAINT unpaid_order_time CHECK (status <> 'unpaid' OR paid_at IS NULL),
  ADD COLUMN platform_order_id text,
  ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'unknown'
    CHECK (fulfillment_status IN ('unknown','unshipped','shipped','delivered')),
  ADD COLUMN fx_rate bi.fx_rate,
  ADD COLUMN fx_source text,
  ADD CONSTRAINT order_fx_source CHECK ((fx_rate IS NULL AND fx_source IS NULL)
      OR (fx_rate IS NOT NULL AND fx_source IS NOT NULL AND length(fx_source) BETWEEN 1 AND 300)),
  ADD CONSTRAINT order_cny_identity CHECK (currency <> 'CNY' OR fx_rate IS NULL OR fx_rate = 1);
UPDATE bi.orders SET platform_order_id=order_id;
CREATE FUNCTION bi.fill_legacy_platform_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.platform_order_id := coalesce(NEW.platform_order_id,NEW.order_id);
  RETURN NEW;
END; $$;
CREATE TRIGGER legacy_platform_order BEFORE INSERT ON bi.orders
  FOR EACH ROW EXECUTE FUNCTION bi.fill_legacy_platform_order();
ALTER TABLE bi.orders ALTER COLUMN platform_order_id SET NOT NULL;
ALTER TABLE bi.orders ADD CONSTRAINT platform_order_identity
  UNIQUE(workspace_id,dataset_id,store_id,platform_order_id);
ALTER TABLE bi.expenses
  ADD COLUMN fx_rate bi.fx_rate,
  ADD COLUMN fx_source text,
  ADD CONSTRAINT expense_fx_source CHECK ((fx_rate IS NULL AND fx_source IS NULL)
      OR (fx_rate IS NOT NULL AND fx_source IS NOT NULL AND length(fx_source) BETWEEN 1 AND 300)),
  ADD CONSTRAINT expense_cny_identity CHECK (currency <> 'CNY' OR fx_rate IS NULL OR fx_rate = 1);
ALTER TABLE bi.refunds
  ALTER COLUMN occurred_at DROP NOT NULL,
  DROP CONSTRAINT refunds_refund_type_check,
  ADD CONSTRAINT refunds_refund_type_check
    CHECK (refund_type IN ('refund_only','return','unshipped_cancel')),
  ADD COLUMN cancelled_quantity bi.quantity NOT NULL DEFAULT 0 CHECK (cancelled_quantity >= 0),
  ADD CONSTRAINT refund_completed_time CHECK (status <> 'completed' OR occurred_at IS NOT NULL),
  ADD CONSTRAINT refund_cancel_quantities CHECK (
    (refund_type='unshipped_cancel' AND returned_quantity=0 AND recoverable_quantity=0
      AND cancelled_quantity>0) OR (refund_type<>'unshipped_cancel' AND cancelled_quantity=0));

CREATE OR REPLACE FUNCTION bi.check_completed_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_amount numeric; original_quantity numeric; payment_time timestamptz;
  payment_status text; fulfillment text;
BEGIN
  SELECT l.paid_amount,l.quantity,o.paid_at,o.status,o.fulfillment_status
    INTO original_amount,original_quantity,payment_time,payment_status,fulfillment
    FROM bi.order_lines l JOIN bi.orders o USING(workspace_id,dataset_id,order_id,store_id)
    WHERE l.workspace_id=NEW.workspace_id AND l.dataset_id=NEW.dataset_id
      AND l.line_id=NEW.line_id FOR UPDATE OF l;
  IF NEW.status='completed' AND original_amount IS NOT NULL THEN
    IF payment_status<>'paid' OR NEW.occurred_at < payment_time THEN
      RAISE EXCEPTION 'Completed refund requires paid order and valid time' USING ERRCODE='23514';
    END IF;
    IF NEW.refund_type='unshipped_cancel' AND fulfillment<>'unshipped' THEN
      RAISE EXCEPTION 'Cancellation cost release requires unshipped evidence' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM (SELECT coalesce(sum(amount),0) AS refunded,
        coalesce(sum(returned_quantity+cancelled_quantity),0) AS returned
        FROM bi.refunds WHERE workspace_id=NEW.workspace_id AND dataset_id=NEW.dataset_id
          AND line_id=NEW.line_id AND status='completed' AND refund_id<>NEW.refund_id) s
        WHERE s.refunded+NEW.amount>original_amount
          OR s.returned+NEW.returned_quantity+NEW.cancelled_quantity>original_quantity) THEN
      RAISE EXCEPTION 'Refund exceeds original payment or units' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION bi.validate_expense_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_store text; original_channel text;
BEGIN
  IF NEW.line_id IS NOT NULL THEN
    SELECT l.store_id,s.channel_id INTO original_store,original_channel
      FROM bi.order_lines l JOIN bi.stores s USING(workspace_id,dataset_id,store_id)
      WHERE l.workspace_id=NEW.workspace_id AND l.dataset_id=NEW.dataset_id
        AND l.line_id=NEW.line_id;
    IF (NEW.store_id IS NOT NULL AND NEW.store_id IS DISTINCT FROM original_store)
       OR (NEW.channel_id IS NOT NULL AND NEW.channel_id IS DISTINCT FROM original_channel) THEN
      RAISE EXCEPTION 'Expense source does not match original order line' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER expense_source BEFORE INSERT OR UPDATE ON bi.expenses
  FOR EACH ROW EXECUTE FUNCTION bi.validate_expense_source();
ALTER TABLE bi.import_batches
  ADD COLUMN preview_id text,
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN errors jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors)='array'),
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT import_preview_ref FOREIGN KEY(workspace_id,dataset_id,preview_id)
    REFERENCES bi.operation_previews;

CREATE TABLE bi.import_rows (
  workspace_id text NOT NULL, dataset_id text NOT NULL, batch_id text NOT NULL,
  resource_type text NOT NULL, row_number bigint NOT NULL CHECK (row_number>0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY(workspace_id,dataset_id,batch_id,resource_type,row_number),
  FOREIGN KEY(workspace_id,dataset_id,batch_id) REFERENCES bi.import_batches
);
ALTER TABLE bi.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY dataset_scope ON bi.import_rows USING
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true)) WITH CHECK
  (workspace_id=current_setting('shopgate.workspace_id',true)
   AND dataset_id=current_setting('shopgate.dataset_id',true));
CREATE TRIGGER import_rows_immutable BEFORE UPDATE OR DELETE ON bi.import_rows
  FOR EACH ROW EXECUTE FUNCTION bi.reject_history_mutation();
