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

# 无真实 CSV 时生成合成行为（演示默认 1,000 个商品）
uv run --project services/commerce-data \
  shopgate-commerce-import generate-synthetic-behavior \
  --users 10000 --days 9 --items 1000

# 重建商品/类目日聚合
uv run --project services/commerce-data \
  shopgate-commerce-import aggregate-daily

# 生成与 v1 事实表隔离的经营分析演示数据集（P27）
uv run --project services/commerce-data \
  shopgate-commerce-import generate-synthetic-analytics-dataset \
  --dataset-id retail-demo-expanded-v1 --users 1000 --items 1000 --days 30 \
  --seed 20251203 --end-day 2025-12-03
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--users` | `10000` | 确定性抽样用户数（≤ 文件内独立用户数） |
| `--items` | `1000`（合成行为） | 合成演示商品池规模；行为按头部/腰部/长尾分布抽样 |
| `--days` | `9`（合成行为） | 合成行为窗口天数 |
| `--seed` | `20251203` | 抽样种子，同种子可复现 |
| `--time-shift` | `last-week` | `last-week`: 平移到最近一个完整周；`none`: 保留原始时间戳 |
| `--anchor-end` | `2017-12-03` | 原始窗口末日（用于平移计算） |

- 演示口径可用 `--time-shift last-week` 把窗口平移到最近完整周（日期为平移后的口径，
  页脚明示"时间戳平移"）。
- 校验口径用 `--time-shift none` 保留原始日期（`behavior_source` 显示真实来源）。

### 3.1 扩展经营分析数据集

`generate-synthetic-analytics-dataset` 不会清空或改写 `commerce.user_behavior_events`、
`commerce.items` 和 v1 日聚合。它只替换同一个 `dataset_id` 下的扩展数据，并写入：

- `dataset_contracts`：版本、时间窗口、种子、行数、合成字段和限制；
- `dataset_behavior_events`：按 `dataset_id` 隔离的行为明细，CSV 导入保留外部来源，合成生成标记为 synthetic；
- `dataset_user_profiles`、`dataset_sessions`、`dataset_channels`、`dataset_campaigns`；
- `dataset_item_economics`、`dataset_orders`、`dataset_inventory_snapshots`；合成经营分析数据集还可包含 `dataset_price_experiment_observations`，用于标记对照/处理组价格实验模拟，不能当作真实因果证据。

默认数据集约 1,000 用户、1,000 商品、30 天库存快照。订单从合成 `buy` 事件派生，成本、折扣、退款、履约和库存状态均为合成；后续 P28 只能在页面中明确这些边界后使用。重复执行同一 `dataset_id` 会幂等替换该数据集，不影响其他数据集。

### 3.2 为什么网页生成数据会使用随机种子

网页中的“生成合成经营分析数据集”并不是从外部数据源读取数据，而是调用确定性生成器。`users`、`items`、`days` 和 `end_day` 决定数据规模与窗口，`seed` 决定同一批实体在该窗口内的可复现抽样。生成器还把 `dataset_id`、实体 ID、日期和生成阶段（例如 `profile`、`price`、`order`、`inventory`）加入独立随机序列，因此会分别生成：

- 用户画像和会话；
- 商品价格、成本、折扣和库存；
- 渠道、活动、订单、退款和履约状态；
- 按日库存快照以及质量扫描所需的关联数据。

同一组参数会得到同一组结果，改动 `seed` 才会得到另一组可复现样本。它是演示数据生成参数，不是业务成员数，也不是外部数据集的标识。网页上的小规模用户数/商品数只用于快速验收；默认入口仍是 1,000 用户、1,000 商品、30 天。

网页另外提供“导入已有数据集（CSV）”入口。CSV 必须包含 `user_id`、`item_id`、`category_id`、`behavior_type`、`timestamp` 五列；Web 任务会保留行为事件来源，并按 `dataset_id` 隔离写入扩展分析表。价格、成本、渠道、订单和库存是行为 CSV 不包含的扩展字段，系统会使用 `seed` 确定性补齐并在契约中标记为合成。当前单文件限制为 50 MB、最多 500,000 行；CSV 之外的格式和第三方来源仍使用离线连接器。

### 3.3 真实价格实验文件的只读校验（P28）

真实价格实验需要同时提供用户分组记录和按商品/日期汇总的观察记录。当前阶段先提供
**只读校验**，校验通过后才进入后续写库和统计分析阶段；校验命令不会连接数据库，也不会
修改已有数据集。

```bash
uv run --project services/commerce-data \
  shopgate-commerce-import validate-price-experiment-csv \
  --assignments data/import/price-experiment-assignments.csv \
  --observations data/import/price-experiment-observations.csv \
  --source my-store-price-experiment
```

用户分组文件必须严格使用以下表头：

```text
experiment_id,user_id,variant,assigned_at,allocation_method
```

观察文件必须严格使用以下表头：

```text
experiment_id,observation_date,item_id,variant,selling_price,exposed_users,purchasers,units,assignment_unit,allocation_method
```

校验规则包括：

- 每个实验都必须同时有 `control`（对照组）和 `treatment`（处理组）；
- 同一个实验中，一个用户只能出现一次分组记录；
- `assigned_at` 必须包含时区，观察日期必须是 `YYYY-MM-DD`；
- `purchasers`（购买人数）不能大于 `exposed_users`（曝光人数），`units`（购买件数）不能小于购买人数；
- `assignment_unit` 必须是 `user`，这样观察数据才能和用户级分组证据对应；
- 每个实验的观察行键（实验、日期、商品、变体）不能重复。

报告中的 `source_kind=observed` 只说明输入来自外部观察文件，`causal_claim=not_verified` 表示
系统仍未据此证明随机化或因果关系。校验成功不等于可以直接宣称价格带来的因果效果。

对应接口为 `POST /api/v1/commerce/datasets/import/csv?dataset_id=...&seed=...&filename=...`，请求体直接发送 UTF-8 CSV（`Content-Type: text/csv`），返回的任务 ID 与合成数据生成任务共用状态查询和质量扫描。

契约可以通过 API 查看：

```bash
curl 'http://127.0.0.1:8000/api/v1/commerce/datasets?dataset_id=retail-demo-expanded-v1'
```

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

> 本文是当前零售数据接入的唯一数据源与连接器说明；历史行业数据接入说明不属于当前运行路径。

## 6. 验证

```bash
# 检查事件来源与窗口
psql "$DATABASE_URL" -c \
  "SELECT source, COUNT(*), MIN(event_ts)::date, MAX(event_ts)::date \
   FROM commerce.user_behavior_events GROUP BY source;"
```

预期：`source='tianchi_userbehavior'`，窗口为所选口径（`none` 时 2017-11-25 ~ 2017-12-03）。
