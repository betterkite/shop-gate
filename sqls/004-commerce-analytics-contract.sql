-- Shop Gate 零售经营分析数据契约与扩展演示数据。
-- 追加式设计：不改写 user_behavior_events 等 v1 事实表；每一批扩展数据由 dataset_id 隔离。
-- 所有生成字段必须标注 source/synthetic，dataset_contracts 记录生成规则和适用限制。

CREATE TABLE IF NOT EXISTS commerce.dataset_contracts (
  dataset_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('observed', 'synthetic', 'mixed')),
  source_name TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  generation_seed BIGINT,
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  synthetic_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_rule TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_start <= window_end)
);

COMMENT ON TABLE commerce.dataset_contracts IS
  '零售分析数据集契约。记录来源、版本、窗口、生成规则、合成字段与限制，不得把合成数据描述为真实业务事实。';

CREATE TABLE IF NOT EXISTS commerce.dataset_behavior_events (
  event_id BIGSERIAL PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  behavior_type TEXT NOT NULL CHECK (behavior_type IN ('pv', 'fav', 'cart', 'buy')),
  event_ts TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS dataset_behavior_events_dataset_ts_idx
  ON commerce.dataset_behavior_events (dataset_id, event_ts);

CREATE INDEX IF NOT EXISTS dataset_behavior_events_item_ts_idx
  ON commerce.dataset_behavior_events (dataset_id, item_id, event_ts);

CREATE INDEX IF NOT EXISTS dataset_behavior_events_type_idx
  ON commerce.dataset_behavior_events (dataset_id, behavior_type);

COMMENT ON TABLE commerce.dataset_behavior_events IS
  '按 dataset_id 隔离的商品行为明细；外部 CSV 行为可保留真实来源，合成演示行为标记 synthetic。';

CREATE TABLE IF NOT EXISTS commerce.dataset_user_profiles (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  age_band TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('female', 'male', 'unknown')),
  city_tier TEXT NOT NULL CHECK (city_tier IN ('tier_1', 'tier_2', 'tier_3_plus')),
  member_level TEXT NOT NULL CHECK (member_level IN ('new', 'standard', 'loyal', 'premium')),
  registered_at DATE NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, user_id)
);

CREATE TABLE IF NOT EXISTS commerce.dataset_channels (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('自然流量', '付费投放', '内容种草', '私域')),
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, channel_id)
);

CREATE TABLE IF NOT EXISTS commerce.dataset_campaigns (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('日常', '大促', '会员', '内容')),
  starts_at DATE NOT NULL,
  ends_at DATE NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, campaign_id),
  CHECK (starts_at <= ends_at)
);

CREATE TABLE IF NOT EXISTS commerce.dataset_sessions (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  channel_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, session_id),
  CHECK (started_at <= ended_at)
);

CREATE INDEX IF NOT EXISTS dataset_sessions_user_time_idx
  ON commerce.dataset_sessions (dataset_id, user_id, started_at);

CREATE TABLE IF NOT EXISTS commerce.dataset_item_economics (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  list_price NUMERIC(10, 2) NOT NULL CHECK (list_price >= 0),
  cost_price NUMERIC(10, 2) NOT NULL CHECK (cost_price >= 0),
  discount_rate NUMERIC(6, 4) NOT NULL CHECK (discount_rate >= 0 AND discount_rate <= 1),
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, item_id),
  CHECK (cost_price <= list_price)
);

CREATE INDEX IF NOT EXISTS dataset_item_economics_category_idx
  ON commerce.dataset_item_economics (dataset_id, category_id);

CREATE TABLE IF NOT EXISTS commerce.dataset_orders (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ordered_at TIMESTAMPTZ NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  selling_price NUMERIC(10, 2) NOT NULL CHECK (selling_price >= 0),
  discount_amount NUMERIC(10, 2) NOT NULL CHECK (discount_amount >= 0),
  refund_amount NUMERIC(10, 2) NOT NULL CHECK (refund_amount >= 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'refunded', 'partially_refunded')),
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('delivered', 'shipped', 'processing')),
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, order_id)
);

CREATE INDEX IF NOT EXISTS dataset_orders_time_idx
  ON commerce.dataset_orders (dataset_id, ordered_at);

CREATE INDEX IF NOT EXISTS dataset_orders_item_idx
  ON commerce.dataset_orders (dataset_id, item_id, ordered_at);

CREATE TABLE IF NOT EXISTS commerce.dataset_price_experiment_observations (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  observation_date DATE NOT NULL,
  item_id BIGINT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('control', 'treatment')),
  selling_price NUMERIC(10, 2) NOT NULL CHECK (selling_price >= 0),
  exposed_users INT NOT NULL CHECK (exposed_users >= 0),
  purchasers INT NOT NULL CHECK (purchasers >= 0),
  units INT NOT NULL CHECK (units >= 0),
  assignment_unit TEXT NOT NULL CHECK (assignment_unit IN ('user', 'session')),
  allocation_method TEXT NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, experiment_id, observation_date, item_id, variant),
  CHECK (purchasers <= exposed_users),
  CHECK (units >= purchasers)
);

CREATE INDEX IF NOT EXISTS dataset_price_experiment_item_idx
  ON commerce.dataset_price_experiment_observations (dataset_id, item_id, observation_date);

COMMENT ON TABLE commerce.dataset_price_experiment_observations IS
  '价格实验观察：明确保存对照/处理组、价格、曝光人数和购买人数；合成实验只能用于演示，不等同于真实因果证据。';

CREATE TABLE IF NOT EXISTS commerce.dataset_price_experiment_assignments (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('control', 'treatment')),
  assigned_at TIMESTAMPTZ NOT NULL,
  allocation_method TEXT NOT NULL,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, experiment_id, user_id)
);

CREATE INDEX IF NOT EXISTS dataset_price_experiment_assignment_variant_idx
  ON commerce.dataset_price_experiment_assignments (dataset_id, experiment_id, variant);

COMMENT ON TABLE commerce.dataset_price_experiment_assignments IS
  '价格实验用户级分组证据。记录用户只被分配到一个变体、分配方法和来源；合成记录不能替代真实随机分组证明。';

CREATE TABLE IF NOT EXISTS commerce.dataset_inventory_snapshots (
  dataset_id TEXT NOT NULL REFERENCES commerce.dataset_contracts (dataset_id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  item_id BIGINT NOT NULL,
  opening_stock INT NOT NULL CHECK (opening_stock >= 0),
  inbound_qty INT NOT NULL CHECK (inbound_qty >= 0),
  sold_qty INT NOT NULL CHECK (sold_qty >= 0),
  reserved_qty INT NOT NULL CHECK (reserved_qty >= 0),
  closing_stock INT NOT NULL CHECK (closing_stock >= 0),
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (dataset_id, snapshot_date, item_id)
);

CREATE INDEX IF NOT EXISTS dataset_inventory_item_date_idx
  ON commerce.dataset_inventory_snapshots (dataset_id, item_id, snapshot_date);

COMMENT ON TABLE commerce.dataset_orders IS
  '扩展订单事实演示数据。金额、退款和履约状态只有在 synthetic=false 且有外部凭据时才能作为真实经营事实。';

COMMENT ON TABLE commerce.dataset_inventory_snapshots IS
  '扩展库存日快照。合成快照用于演示库存预测/补货分析，不代表真实仓库库存。';
