-- Private BI answers and original-version table chunks; no legacy rows change.
CREATE TABLE "bi_agent_results" (
  "id" TEXT PRIMARY KEY, "run_id" TEXT NOT NULL, "operation_id" TEXT NOT NULL,
  "query" JSONB NOT NULL, "metadata" JSONB NOT NULL, "total" INTEGER NOT NULL,
  "collected" INTEGER NOT NULL DEFAULT 0, "complete" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bi_agent_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bi_agent_results_bounds" CHECK (total >= 0 AND collected >= 0 AND collected <= total AND (NOT complete OR collected = total)
    AND jsonb_typeof(query) = 'object' AND jsonb_typeof(metadata) = 'object'
    AND octet_length(query::text) <= 32768 AND octet_length(metadata::text) <= 131072)
);
CREATE UNIQUE INDEX "bi_agent_results_run_id_operation_id_key" ON "bi_agent_results"("run_id", "operation_id");
CREATE TABLE "bi_agent_result_pages" (
  "result_id" TEXT NOT NULL, "page" INTEGER NOT NULL, "rows" JSONB NOT NULL, "digest" TEXT NOT NULL,
  PRIMARY KEY ("result_id", "page"),
  CONSTRAINT "bi_agent_result_pages_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "bi_agent_results"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bi_agent_result_pages_bounds" CHECK (page > 0 AND jsonb_typeof(rows) = 'array'
    AND jsonb_array_length(rows) BETWEEN 1 AND 100 AND octet_length(rows::text) <= 2097152 AND digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "bi_agent_answers" (
  "run_id" TEXT PRIMARY KEY, "content" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bi_agent_answers_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bi_agent_answers_bounds" CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 65536)
);
-- Completed query facts and displayed answers are immutable. Deletion still
-- follows the owned conversation/run cascade and never changes source ledgers.
CREATE FUNCTION shopgate_bi_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bi_agent_results' THEN
    IF TG_OP = 'UPDATE' AND (OLD.complete OR NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
      OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.query IS DISTINCT FROM OLD.query
      OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.total IS DISTINCT FROM OLD.total) THEN
      RAISE EXCEPTION 'BI result identity and completed facts are immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND bi_request_id IS NOT NULL) THEN
      RAISE EXCEPTION 'BI result requires a BI run';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'BI answer and result pages are immutable';
  ELSIF TG_TABLE_NAME = 'bi_agent_answers' THEN
    IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND bi_request_id IS NOT NULL) THEN
      RAISE EXCEPTION 'BI answer requires a BI run';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM bi_agent_results WHERE id=NEW.result_id AND complete) THEN
    RAISE EXCEPTION 'Completed BI result pages are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bi_agent_results_guard BEFORE INSERT OR UPDATE ON bi_agent_results FOR EACH ROW EXECUTE FUNCTION shopgate_bi_result_guard();
CREATE TRIGGER bi_agent_result_pages_guard BEFORE INSERT OR UPDATE ON bi_agent_result_pages FOR EACH ROW EXECUTE FUNCTION shopgate_bi_result_guard();
CREATE TRIGGER bi_agent_answers_guard BEFORE INSERT OR UPDATE ON bi_agent_answers FOR EACH ROW EXECUTE FUNCTION shopgate_bi_result_guard();
