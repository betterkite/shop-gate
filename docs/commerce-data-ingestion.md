# 零售数据接入：真实 UserBehavior 与自有数据连接器

Shop Gate 的零售数据链路以本地 PostgreSQL + TimescaleDB 为事实库，外部数据源只作为
采集入口。本文说明 v1 离线的**真实数据导入**方式，以及未来接**自有真实数据**的连接器
接口。口径红线见 [数据字典](data-dictionary.md) 与 [PRD §5](prd.md)。

## 1. 真实/合成边界（红线，先讲清楚）

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| `commerce.user_behavior_events` | 真实行为流（`source='tianchi_userbehavior'`） | 天池淘宝 UserBehavior（dataset 649）的 pv/fav/cart/buy 事件 |
| `commerce.items` / `categories` / `brands` / `shops` | 合成主数据（`synthetic_master` 标注） | 价格/库存/品牌/店铺**是合成**——UserBehavior 没有这些字段 |
| `gmv` | `buy 事件数 × 合成价格` | PRD §5.2，金额为合成口径 |

所以"真实"指的是**行为事件流**；金额/库存仍属合成，dashboard 必须带"合成口径"徽标，
页脚通过 `behavior_source` 明示来源。任何回答不得把合成金额表述为真实交易。

## 2. 数据契约（连接器接口的输入侧）

事件导入统一落到 `commerce.user_behavior_events`，对外只接受一种 CSV 契约：

| 列 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `user_id` | int | 是 | 用户 ID |
| `item_id` | int | 是 | 商品 ID |
| `category_id` | int | 是 | 类目 ID |
| `behavior_type` | string | 是 | 仅 `pv` / `fav` / `cart` / `buy` |
| `timestamp` | int | 是 | Unix 秒（UTC） |

- CSV **必须有表头**，且列名顺序严格为上述五列（`scan_userbehavior_csv` 校验）。
- `event_ts` 由 `timestamp`（Unix 秒）转换而来；`source` 写入当前 provider。
- 每个导入任务写入 `commerce.market_data_ingestion_jobs`，每个 provider 的水位写入
  `commerce.market_data_sync_state` —— 这是未来接自有数据要复用的"连接器书签"。

## 3. v1 离线连接器：`shopgate-commerce-import`

真实数据从公开镜像截取为窗口内 CSV 后（如 2017-11-25~12-03，见下方 §5），执行：

```bash
# 导入真实行为事件流（10,000 用户确定性抽样）
uv run --project services/commerce-data \
  shopgate-commerce-import import-userbehavior \
  --csv data/import/userbehavior.csv \
  --users 10000 --seed 20251203 \
  --time-shift none --anchor-end 2017-12-03

# 按事件流生成合成商品主数据
uv run --project services/commerce-data \
  shopgate-commerce-import generate-synthetic-master

# 重建商品/类目日聚合
uv run --project services/commerce-data \
  shopgate-commerce-import aggregate-daily
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--users` | `10000` | 确定性抽样用户数（≤ 文件内独立用户数） |
| `--seed` | `20251203` | 抽样种子，同种子可复现 |
| `--time-shift` | `last-week` | `last-week`: 平移到最近一个完整周；`none`: 保留原始时间戳 |
| `--anchor-end` | `2017-12-03` | 原始窗口末日（用于平移计算） |

- 演示口径可用 `--time-shift last-week` 把窗口平移到最近完整周（日期为平移后的口径，
  页脚明示"时间戳平移"）。
- 校验口径用 `--time-shift none` 保留原始日期（`behavior_source` 显示真实来源）。

## 4. 接入自有真实数据

未来接自己/第三方数据的连接器接口 = **复用同一事件契约 + 注册一个 provider**：

1. **对齐契约**：把自有数据映射到 §2 的五列（`behavior_type` 归一为 pv/fav/cart/buy；
   `timestamp` 统一为 Unix 秒 UTC）。
2. **注册 provider**（代码层）：新建一个 `import-*` 子命令或复用 `import-userbehavior`，
   在 `_register_ingestion_job` 处写入 `provider`（区分 `userbehavior_csv` / `synthetic` /
   自有 provider 名）。
3. **标注来源**：`source` 列写对应来源；`metadata.mode` 写真实/合成；页脚 `behavior_source`
   自动反映。
4. **主数据**：若自有数据带价格/库存，可把 `commerce.items` 的 `synthetic_master` 改为
   真实标注并接入；否则维持合成口径（§1 红线不变）。

二期接入淘宝/京东/抖店开放 API 时，其 Connector 遵循
[Data Agent 平台与 Domain Pack 架构](data-agent-architecture.md) 的 Connector 约定，
把开放 API 的事件流归一成同一事件契约后走同一导入路径。

## 5. 天池 UserBehavior 的获取与窗口口径

- 原始数据集：阿里云天池 [UserBehavior（dataset 649）](https://tianchi.aliyun.com/dataset/649)，
  官方需账号登录下载（约 1 亿行为事件，2017-11-25 ~ 2017-12-03，含双十二预热）。
- 公开镜像：Kaggle
  [User Behavior Data from Taobao for Recommendation](https://www.kaggle.com/datasets/marwa80/userbehavior)
  及若干 GitHub 仓库。
- **窗口过滤**：完整 649 数据集超过 GitHub 单文件 100MB 上限，GitHub 镜像普遍只保留
  用户级别样本切片。本项目导入前用脚本把切片**过滤到规范窗口**（`2017-11-25` ~
  `2017-12-03`）并输出五列 + 表头，保证 dashboard 窗口与 PRD 一致。

> 本文是当前零售数据接入的唯一数据源与连接器说明；旧金融行情知识库已删除。
> （`quant.*` / 东方财富 / Baostock 口径），待 P10 文档终审时归并或清理；零售数据接入以本文为准。

## 6. 验证

```bash
# 检查事件来源与窗口
psql "$DATABASE_URL" -c \
  "SELECT source, COUNT(*), MIN(event_ts)::date, MAX(event_ts)::date \
   FROM commerce.user_behavior_events GROUP BY source;"
```

预期：`source='tianchi_userbehavior'`，窗口为所选口径（`none` 时 2017-11-25 ~ 2017-12-03）。
