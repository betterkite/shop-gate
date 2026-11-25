-- Keep the former price addressable by every original payment snapshot.
ALTER TABLE bi.cost_versions ADD COLUMN superseded_version bigint
  CHECK (superseded_version IS NULL OR superseded_version > created_version);

CREATE OR REPLACE FUNCTION bi.protect_cost_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'valid_to' - 'superseded_version')
       IS DISTINCT FROM (to_jsonb(OLD) - 'valid_to' - 'superseded_version')
     OR (OLD.superseded_version IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Cost facts are versioned, not overwritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bi.prevent_cost_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bi.skus WHERE workspace_id = NEW.workspace_id
    AND dataset_id = NEW.dataset_id AND sku_id = NEW.sku_id FOR UPDATE;
  IF NEW.superseded_version IS NULL AND EXISTS (
    SELECT 1 FROM bi.cost_versions WHERE workspace_id = NEW.workspace_id
      AND dataset_id = NEW.dataset_id AND sku_id = NEW.sku_id AND level = NEW.level
      AND channel_id IS NOT DISTINCT FROM NEW.channel_id
      AND store_id IS NOT DISTINCT FROM NEW.store_id AND cost_id <> NEW.cost_id
      AND superseded_version IS NULL
      AND valid_from < coalesce(NEW.valid_to, 'infinity'::timestamptz)
      AND NEW.valid_from < coalesce(valid_to, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'Overlapping cost intervals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
