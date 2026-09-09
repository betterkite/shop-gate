-- Rename active access-control and quota identifiers from the QuantPilot
-- vocabulary to the Shop Gate commerce/operations vocabulary. Historical
-- migration files remain immutable; existing runtime rows are migrated here.

UPDATE "permission_profile_grants"
SET "permission_key" = CASE "permission_key"
  WHEN 'quant.data.read' THEN 'commerce.data.read'
  WHEN 'quant.query.rewrite.llm' THEN 'commerce.query.rewrite.llm'
  WHEN 'quant.strategy.run' THEN 'commerce.operation.run'
  WHEN 'quant.strategy.manage' THEN 'commerce.operation.manage'
  WHEN 'research.report.read' THEN 'operations.brief.read'
  WHEN 'research.report.run' THEN 'operations.brief.run'
  WHEN 'research.report.send' THEN 'operations.brief.send'
  ELSE "permission_key"
END
WHERE "permission_key" IN (
  'quant.data.read', 'quant.query.rewrite.llm', 'quant.strategy.run',
  'quant.strategy.manage', 'research.report.read', 'research.report.run',
  'research.report.send'
);

UPDATE "user_permission_overrides"
SET "permission_key" = CASE "permission_key"
  WHEN 'quant.data.read' THEN 'commerce.data.read'
  WHEN 'quant.query.rewrite.llm' THEN 'commerce.query.rewrite.llm'
  WHEN 'quant.strategy.run' THEN 'commerce.operation.run'
  WHEN 'quant.strategy.manage' THEN 'commerce.operation.manage'
  WHEN 'research.report.read' THEN 'operations.brief.read'
  WHEN 'research.report.run' THEN 'operations.brief.run'
  WHEN 'research.report.send' THEN 'operations.brief.send'
  ELSE "permission_key"
END
WHERE "permission_key" IN (
  'quant.data.read', 'quant.query.rewrite.llm', 'quant.strategy.run',
  'quant.strategy.manage', 'research.report.read', 'research.report.run',
  'research.report.send'
);

UPDATE "quota_rules"
SET "metric" = CASE "metric"
  WHEN 'query_rewrite.llm.daily' THEN 'commerce.query_rewrite.llm.daily'
  WHEN 'quant.data_units.daily' THEN 'commerce.data_units.daily'
  WHEN 'research.report_runs.daily' THEN 'operations.brief_runs.daily'
  WHEN 'research.report_sends.daily' THEN 'operations.brief_sends.daily'
  ELSE "metric"
END
WHERE "metric" IN (
  'query_rewrite.llm.daily', 'quant.data_units.daily',
  'research.report_runs.daily', 'research.report_sends.daily'
);

UPDATE "user_quota_overrides"
SET "metric" = CASE "metric"
  WHEN 'query_rewrite.llm.daily' THEN 'commerce.query_rewrite.llm.daily'
  WHEN 'quant.data_units.daily' THEN 'commerce.data_units.daily'
  WHEN 'research.report_runs.daily' THEN 'operations.brief_runs.daily'
  WHEN 'research.report_sends.daily' THEN 'operations.brief_sends.daily'
  ELSE "metric"
END
WHERE "metric" IN (
  'query_rewrite.llm.daily', 'quant.data_units.daily',
  'research.report_runs.daily', 'research.report_sends.daily'
);

UPDATE "usage_buckets"
SET "metric" = CASE "metric"
  WHEN 'query_rewrite.llm.daily' THEN 'commerce.query_rewrite.llm.daily'
  WHEN 'quant.data_units.daily' THEN 'commerce.data_units.daily'
  WHEN 'research.report_runs.daily' THEN 'operations.brief_runs.daily'
  WHEN 'research.report_sends.daily' THEN 'operations.brief_sends.daily'
  ELSE "metric"
END
WHERE "metric" IN (
  'query_rewrite.llm.daily', 'quant.data_units.daily',
  'research.report_runs.daily', 'research.report_sends.daily'
);

UPDATE "quota_reservations"
SET "metric" = CASE "metric"
  WHEN 'query_rewrite.llm.daily' THEN 'commerce.query_rewrite.llm.daily'
  WHEN 'quant.data_units.daily' THEN 'commerce.data_units.daily'
  WHEN 'research.report_runs.daily' THEN 'operations.brief_runs.daily'
  WHEN 'research.report_sends.daily' THEN 'operations.brief_sends.daily'
  ELSE "metric"
END
WHERE "metric" IN (
  'query_rewrite.llm.daily', 'quant.data_units.daily',
  'research.report_runs.daily', 'research.report_sends.daily'
);

UPDATE "usage_events"
SET "metric" = CASE "metric"
  WHEN 'query_rewrite.llm.daily' THEN 'commerce.query_rewrite.llm.daily'
  WHEN 'quant.data_units.daily' THEN 'commerce.data_units.daily'
  WHEN 'research.report_runs.daily' THEN 'operations.brief_runs.daily'
  WHEN 'research.report_sends.daily' THEN 'operations.brief_sends.daily'
  ELSE "metric"
END
WHERE "metric" IN (
  'query_rewrite.llm.daily', 'quant.data_units.daily',
  'research.report_runs.daily', 'research.report_sends.daily'
);
