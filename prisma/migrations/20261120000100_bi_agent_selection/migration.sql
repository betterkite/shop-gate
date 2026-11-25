-- Existing questions have no evidence selection. New references are immutable
-- along with the request and the effective page scope used by its worker.
ALTER TABLE bi_agent_requests ADD COLUMN evidence_selection JSONB,
  ADD CONSTRAINT bi_agent_requests_selection_bounds CHECK (
    evidence_selection IS NULL OR (
      jsonb_typeof(evidence_selection) = 'object'
      AND evidence_selection ? 'positions'
      AND jsonb_typeof(evidence_selection->'positions') = 'array'
      AND jsonb_array_length(evidence_selection->'positions') BETWEEN 1 AND 100
      AND octet_length(evidence_selection::text) <= 262144
    )
  );
