-- Shop Gate 平台级基础组件 bootstrap SQL。
-- 平台数据导入与同步表：保留稳定的基础结构和兼容字段，
-- 默认值采用零售数据口径（provider=userbehavior_csv / adjustment=none）。
-- 可重复执行。

CREATE TABLE IF NOT EXISTS commerce.market_data_ingestion_jobs (
  id TEXT PRIMARY KEY,
  universe_id TEXT,
  provider TEXT NOT NULL DEFAULT 'userbehavior_csv',
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'none',
  requested_start DATE,
  requested_end DATE,
  status TEXT NOT NULL DEFAULT 'queued',
  total_symbols INT NOT NULL DEFAULT 0,
  completed_symbols INT NOT NULL DEFAULT 0,
  failed_symbols INT NOT NULL DEFAULT 0,
  rows_received INT NOT NULL DEFAULT 0,
  rows_upserted INT NOT NULL DEFAULT 0,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_data_ingestion_jobs_created_idx
  ON commerce.market_data_ingestion_jobs (created_at DESC);

COMMENT ON TABLE commerce.market_data_ingestion_jobs IS
  '数据导入任务表。universe_id 保留为通用外置 ID，不绑定具体行业主数据。';

CREATE TABLE IF NOT EXISTS commerce.market_data_sync_state (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'none',
  provider TEXT NOT NULL DEFAULT 'userbehavior_csv',
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ,
  row_count INT NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, adjustment, provider)
);

CREATE INDEX IF NOT EXISTS market_data_sync_state_last_ts_idx
  ON commerce.market_data_sync_state (last_ts DESC);

COMMENT ON TABLE commerce.market_data_sync_state IS
  '数据源同步水位表。symbol 为数据源通用键（如数据集分片），无行业外键。';

CREATE TABLE IF NOT EXISTS commerce.data_quality_scans (
  id TEXT PRIMARY KEY,
  universe_id TEXT,
  symbol TEXT,
  scope TEXT NOT NULL DEFAULT 'universe',
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'completed',
  severity TEXT NOT NULL DEFAULT 'ok',
  checked_symbols INT NOT NULL DEFAULT 0,
  passed_symbols INT NOT NULL DEFAULT 0,
  warning_symbols INT NOT NULL DEFAULT 0,
  failed_symbols INT NOT NULL DEFAULT 0,
  checked_rows INT NOT NULL DEFAULT 0,
  issue_count INT NOT NULL DEFAULT 0,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_quality_scans_created_idx
  ON commerce.data_quality_scans (created_at DESC);

CREATE INDEX IF NOT EXISTS data_quality_scans_scope_idx
  ON commerce.data_quality_scans (universe_id, symbol, created_at DESC);

COMMENT ON TABLE commerce.data_quality_scans IS
  '数据质量扫描结果。记录导入覆盖率、缺失、重复等检查摘要。';

CREATE TABLE IF NOT EXISTS commerce.platform_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INT NOT NULL DEFAULT 100,
  progress NUMERIC(7, 4) NOT NULL DEFAULT 0,
  control TEXT NOT NULL DEFAULT 'run',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_jobs_queue_status_priority_idx
  ON commerce.platform_jobs (queue, status, priority, created_at);

CREATE INDEX IF NOT EXISTS platform_jobs_type_created_idx
  ON commerce.platform_jobs (job_type, created_at DESC);

COMMENT ON TABLE commerce.platform_jobs IS
  '通用平台任务表。Worker 可基于此承载导入、聚合和质量扫描任务。';
