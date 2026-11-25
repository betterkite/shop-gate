-- Superseded definitions remain available to original payment snapshots and audit.
ALTER TABLE bi.mappings ADD COLUMN superseded_version bigint
  CHECK (superseded_version IS NULL OR superseded_version > created_version);

CREATE OR REPLACE FUNCTION bi.prevent_mapping_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bi.listings WHERE workspace_id = NEW.workspace_id
    AND dataset_id = NEW.dataset_id AND listing_id = NEW.listing_id FOR UPDATE;
  IF NEW.superseded_version IS NULL AND EXISTS (
    SELECT 1 FROM bi.mappings WHERE workspace_id = NEW.workspace_id
      AND dataset_id = NEW.dataset_id AND listing_id = NEW.listing_id
      AND mapping_id <> NEW.mapping_id AND superseded_version IS NULL
      AND valid_from < coalesce(NEW.valid_to, 'infinity'::timestamptz)
      AND NEW.valid_from < coalesce(valid_to, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'Overlapping mapping intervals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
