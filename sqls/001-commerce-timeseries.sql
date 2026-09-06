-- Shop Gate 零售行为时序 bootstrap SQL。
-- 可重复执行。Docker 首次建库时使用，`npm run db:init` 也可对已有本地库补齐。

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS commerce;

-- 真实用户行为流（天池 UserBehavior 抽样导入）。
-- 口径：pv/fav/cart/buy 四类事件；金额字段一律不出现在本表（见 commerce.items 合成主数据）。
CREATE TABLE IF NOT EXISTS commerce.user_behavior_events (
  event_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  behavior_type TEXT NOT NULL CHECK (behavior_type IN ('pv', 'fav', 'cart', 'buy')),
  event_ts TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'tianchi_userbehavior',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_behavior_events_ts_idx
  ON commerce.user_behavior_events (event_ts);

CREATE INDEX IF NOT EXISTS user_behavior_events_user_ts_idx
  ON commerce.user_behavior_events (user_id, event_ts);

CREATE INDEX IF NOT EXISTS user_behavior_events_item_ts_idx
  ON commerce.user_behavior_events (item_id, event_ts);

CREATE INDEX IF NOT EXISTS user_behavior_events_category_ts_idx
  ON commerce.user_behavior_events (category_id, event_ts);

CREATE INDEX IF NOT EXISTS user_behavior_events_type_ts_idx
  ON commerce.user_behavior_events (behavior_type, event_ts);

COMMENT ON TABLE commerce.user_behavior_events IS
  '真实用户行为事件流（抽样导入）。仅行为事实，不含金额；金额口径见 items/日聚合。';

-- 商品日聚合（导入后由聚合脚本生成，PRD §5.4）。
-- gmv = buy 事件数 × 当日 items.price（合成静态价格，PRD §5.2/§5.3）。
CREATE TABLE IF NOT EXISTS commerce.daily_item_metrics (
  stat_date DATE NOT NULL,
  item_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  pv BIGINT NOT NULL DEFAULT 0,
  fav BIGINT NOT NULL DEFAULT 0,
  cart BIGINT NOT NULL DEFAULT 0,
  buy BIGINT NOT NULL DEFAULT 0,
  gmv NUMERIC(14, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, item_id)
);

CREATE INDEX IF NOT EXISTS daily_item_metrics_item_date_idx
  ON commerce.daily_item_metrics (item_id, stat_date DESC);

CREATE INDEX IF NOT EXISTS daily_item_metrics_category_date_idx
  ON commerce.daily_item_metrics (category_id, stat_date);

COMMENT ON TABLE commerce.daily_item_metrics IS
  '商品×日聚合（pv/fav/cart/buy/gmv）。gmv 依赖合成价格，展示需带合成口径标注。';

-- 类目日聚合（含去重购买用户数，供人均口径）。
CREATE TABLE IF NOT EXISTS commerce.daily_category_metrics (
  stat_date DATE NOT NULL,
  category_id BIGINT NOT NULL,
  pv BIGINT NOT NULL DEFAULT 0,
  fav BIGINT NOT NULL DEFAULT 0,
  cart BIGINT NOT NULL DEFAULT 0,
  buy BIGINT NOT NULL DEFAULT 0,
  buyers BIGINT NOT NULL DEFAULT 0,
  gmv NUMERIC(14, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, category_id)
);

CREATE INDEX IF NOT EXISTS daily_category_metrics_date_idx
  ON commerce.daily_category_metrics (stat_date DESC);

COMMENT ON TABLE commerce.daily_category_metrics IS
  '类目×日聚合。buyers 为当日去重购买用户数；客单价口径 = gmv / buy（件单价，PRD §6.2）。';
