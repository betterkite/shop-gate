-- Shop Gate 零售商品主数据 bootstrap SQL。
-- 合成主数据（PRD §5.2）：价格/库存/品牌/店铺由导入脚本确定性生成，同一种子可复现。
-- category_id 继承真实行为流；name 为合成映射，必须带 synthetic_name 标注。
-- 可重复执行。

CREATE TABLE IF NOT EXISTS commerce.brands (
  brand_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE commerce.brands IS '合成品牌池（~200）。品牌归属仅用于演示分析，不代表真实品牌。';

CREATE TABLE IF NOT EXISTS commerce.shops (
  shop_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  synthetic BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE commerce.shops IS '合成店铺池（~500，含 tier 分层）。店铺归属仅用于演示分析。';

CREATE TABLE IF NOT EXISTS commerce.categories (
  category_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  synthetic_name BOOLEAN NOT NULL DEFAULT true,
  parent_id BIGINT REFERENCES commerce.categories (category_id) ON DELETE SET NULL
);

COMMENT ON TABLE commerce.categories IS
  '类目表。category_id 为真实行为流中的类目 ID；name 为合成映射（synthetic_name=true）。';

CREATE TABLE IF NOT EXISTS commerce.items (
  item_id BIGINT PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES commerce.categories (category_id),
  title TEXT NOT NULL,
  brand_id BIGINT REFERENCES commerce.brands (brand_id) ON DELETE SET NULL,
  shop_id BIGINT REFERENCES commerce.shops (shop_id) ON DELETE SET NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  listed_at TIMESTAMPTZ,
  synthetic_master BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS items_category_idx
  ON commerce.items (category_id);

CREATE INDEX IF NOT EXISTS items_shop_idx
  ON commerce.items (shop_id);

CREATE INDEX IF NOT EXISTS items_price_idx
  ON commerce.items (price);

COMMENT ON TABLE commerce.items IS
  '商品（SKU）主数据。item_id/category_id 为真实 ID；title/价格/库存/品牌/店铺为合成档案（PRD §5.2）。GMV 口径 = buy × price。';
