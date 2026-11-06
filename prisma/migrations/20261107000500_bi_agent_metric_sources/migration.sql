-- Add definition citations without rewriting any existing facts or answers.
CREATE TABLE "bi_agent_metric_sources" (
  "id" TEXT PRIMARY KEY, "run_id" TEXT NOT NULL,
  "metrics" JSONB NOT NULL, "digest" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bi_agent_metric_sources_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bi_agent_metric_sources_bounds" CHECK (jsonb_typeof(metrics) = 'array'
    AND jsonb_array_length(metrics) BETWEEN 1 AND 100 AND octet_length(metrics::text) <= 262144
    AND digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "bi_agent_metric_sources_run_id_key" ON "bi_agent_metric_sources"("run_id");
CREATE FUNCTION shopgate_bi_metric_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'BI dictionary evidence is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND bi_request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'BI dictionary evidence requires a BI run';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bi_agent_metric_sources_guard BEFORE INSERT OR UPDATE ON bi_agent_metric_sources
  FOR EACH ROW EXECUTE FUNCTION shopgate_bi_metric_source_guard();
