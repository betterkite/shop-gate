-- Remove finance strategy-scan models (PRD §5.5, item E: StrategyScan* v1 removal).

DROP TABLE IF EXISTS "strategy_scan_jobs";
DROP TABLE IF EXISTS "strategy_scan_runs";
