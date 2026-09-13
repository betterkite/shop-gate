-- Retail domain models (PRD §5.5): rename research-* tables to operations-brief
-- naming. Data preserved; StrategyScan* removal deferred to P3 with its feature
-- code removal.

ALTER TABLE "research_watchlists" RENAME TO "brief_watch_pools";

ALTER TABLE "research_report_runs" RENAME TO "operation_brief_runs";

ALTER TABLE "research_reports" RENAME TO "operation_briefs";
