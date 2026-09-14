-- P32 经营分析跨服务编排合同：项目绑定、幂等任务和可重试事件。
-- commerce-data 与主应用使用不同数据库，因此 project_id 保留为经授权的外部 ID，
-- 不在这里创建跨数据库外键。所有 DDL 必须可重复执行。

ALTER TABLE commerce.platform_jobs
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS platform_jobs_project_type_idempotency_idx
  ON commerce.platform_jobs (job_type, project_id, idempotency_key)
  WHERE project_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_jobs_project_created_idx
  ON commerce.platform_jobs (project_id, created_at DESC);

COMMENT ON COLUMN commerce.platform_jobs.project_id IS
  '发起 Agent 编排的主应用项目外部 ID；由上游授权，不在 commerce 数据库中解析。';

COMMENT ON COLUMN commerce.platform_jobs.idempotency_key IS
  '同一项目、任务类型下的幂等请求键，避免重复导入或重复生成看板。';

CREATE TABLE IF NOT EXISTS commerce.analytics_orchestration_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  job_id TEXT NOT NULL REFERENCES commerce.platform_jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  sequence INT NOT NULL CHECK (sequence > 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence),
  UNIQUE (project_id, idempotency_key, event_type)
);

CREATE INDEX IF NOT EXISTS analytics_orchestration_events_project_pending_idx
  ON commerce.analytics_orchestration_events (project_id, consumed_at, created_at);

CREATE INDEX IF NOT EXISTS analytics_orchestration_events_job_sequence_idx
  ON commerce.analytics_orchestration_events (job_id, sequence);

COMMENT ON TABLE commerce.analytics_orchestration_events IS
  '导入与看板编排的持久事件 outbox；消费者成功处理后写入 consumed_at，未确认事件可重试。';
