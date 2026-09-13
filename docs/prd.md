# Shop Gate PRD — 零售电商 Data Agent v1

| 项 | 值 |
| --- | --- |
| 版本 | v0.1（草案，待用户签字） |
| 状态 | 待审查（ISSUE-P1） |
| 关联 | PROVENANCE.md、ISSUES.md（P1→P10） |
| 范围声明 | 本文是 P2–P10 全部代码改动与验收的唯一需求依据；签字后进入 P2 |

---

## 1. 产品定位

Shop Gate 是一个**零售电商领域的 Data Agent 工作台**：运营者/分析师用自然语言提出经营问题，Agent 组合零售领域知识（商品/类目/流量/转化/库存）、真实行为数据与 Skills，生成**可运行、可追溯、好看的**经营 dashboard。平台内核提供 PI Agent 治理层、Data Agent 合同、生成与预览链路；当前领域内核只装零售，默认 Profile 指向零售。

一句话：**用自然语言"问生意"**——数据来自真实行为流与商品主数据（流量/转化/GMV/库存），dashboard 直接呈现经营视图，平台治理与生成质量能力保持原水准。

## 2. 用户与典型场景

| 用户 | 场景 |
| --- | --- |
| 电商运营 | "数据窗口内 GMV 最高的是哪几个类目？转化率和客单价对比如何？" |
| 类目运营 | "从浏览到购买哪个环节流失最大？集中在哪些类目？" |
| 库存/采销 | "库销比最差的 10 个商品是哪些？它们的流量转化情况如何？" |
| 经营负责人 | "昨天的经营日报：GMV、转化、异动类目、观察池动态。" |

## 3. v1 能力范围（4 个 Capability，Q24a）

Domain Pack ID：`retail.core`；默认 Profile ID：`shopgate.retail-ops`。

### 3.1 流量与购买转化（`retail.traffic-funnel`）

- **问题示例**：整体/分类目/分商品的 pv→fav→cart→buy 漏斗；各环节转化率与流失；按日趋势。
- **输入**：`commerce.user_behavior_events`（真实行为流）。
- **dashboard 形态**：浏览到购买的转化图 + 分日转化率折线 + 分类目转化对比表。

### 3.2 类目与商品结构（`retail.catalog-structure`）

- **问题示例**：GMV top-N 类目；类目集中度（top-5 类目 GMV 占比）；高曝光低转化商品清单（动销诊断）。
- **输入**：行为流 × `commerce.items`/`commerce.categories`。
- **dashboard 形态**：类目 GMV 柱状、曝光-转化散点、类目集中度占比环。

### 3.3 价格与库存（合成口径，`retail.price-inventory`）

- **问题示例**：价格带分布；库销比（库存/日销）排名；滞销清单。
- **输入**：`commerce.items`（合成主数据：价格/库存/品牌/店铺）× 行为聚合。
- **dashboard 形态**：价格带直方图、库销比排行表、滞销商品清单。
- **口径红线**：所有金额/库存数字**必须**在 dashboard 上带"合成口径"徽标（见 §5.3）。

### 3.4 经营情报日报（`retail.daily-brief`）

- **问题示例**：昨日经营摘要（GMV/转化/客单价）+ 环比 + 异动类目 + 观察池动态。
- **输入**：`commerce.daily_category_metrics` + 观察池。
- **dashboard 形态**：摘要卡 + 异动榜单 + 观察池变化表。
- **v1 边界**：日报生成链路在最小闭环内可用；自动化推送/回执为 P7 范围。

## 4. 非目标（Q16a，代码保留、不验收）

1. 登录/权限/配额/评测平台/运行治理中心：**代码原样保留**，不在最小闭环验收范围。
2. 定价策略优化、选品推荐、履约、客服：二期。
3. 真实电商平台开放 API（淘宝/京东/抖店）：二期；Connector 保持可插拔，v1 只做离线导入。
4. 日报自动推送与回执：P7。
5. 模型层改造：ModelPort/本地 Qwen/DeepSeek 机制原样沿用（Q9a），任何模型层改动都不在本 PRD 范围。

## 5. 数据口径

### 5.1 真实数据：天池 UserBehavior（dataset 649）

- 字段：`user_id`、`item_id`、`category_id`、`behavior_type`（pv/fav/cart/buy）、`timestamp`（Unix 秒）。
- 原始规模：约 1 亿条事件、2017-11-25 ~ 2017-12-03（9 天窗口，含双十二预热）。
- **抽样策略（待确认项 A）**：随机抽取 **10,000 用户**的全量行为（预计 ~100 万事件），时间窗保持完整 9 天。理由：单机导入/查询轻量，用户级漏斗完整；如需更大规模再调参。
- 导入与自有数据连接器接口见 [零售数据接入：真实 UserBehavior 与自有数据连接器](commerce-data-ingestion.md)。

### 5.2 合成商品主数据（Q22a）

对抽样命中的 `item_id` 全集生成 SKU 档案（导入脚本确定性生成，同一种子可复现）：

| 字段 | 生成规则（v1 提案） |
| --- | --- |
| `category_id` | **真实**（继承行为流） |
| 类目名 | 合成映射（`cat_#id` + 常用词表），标注 `synthetic_name=true` |
| 价格 | 类目基准对数正态（类目基准由该类目行为量排序映射到价格档） |
| 库存 | 0–5000 均匀 + 长尾 |
| 品牌 | 合成品牌池（~200） |
| 店铺 | 合成店铺池（~500，含 tier） |
| 上架时间 | 数据窗口前 0–365 天 |

**GMV 口径**：`buy 事件数 × 静态价格`。v1 价格为静态属性（不做价格时序），价格带分析基于分布；价格历史为二期。

### 5.3 合成边界透明化（红线）

- 金额/库存/品牌/店铺数字全部来自合成主数据 → dashboard 渲染时必须显示"合成口径"徽标与说明 tooltip。
- 真实/合成字段在数据字典中逐表标注（`synthetic_master` 列）。
- Agent 生成的回答不得把合成金额表述为真实交易数据。

### 5.4 数据库 schema（P2 落地，`commerce.*`）

| 表 | 说明 |
| --- | --- |
| `commerce.user_behavior_events` | 真实行为流（source=tianchi_userbehavior，event_ts 转换自 Unix 秒） |
| `commerce.items` / `commerce.categories` / `commerce.brands` / `commerce.shops` | 合成主数据（synthetic 标注列） |
| `commerce.daily_item_metrics` / `commerce.daily_category_metrics` | 导入后 SQL 生成的日聚合（pv/fav/cart/buy/gmv/conversion） |
| 平台表 | `platform_jobs`、`market_data_sync_state`、`market_data_ingestion_jobs`、`data_quality_scans` |

### 5.5 经营情报相关领域模型（Prisma）

| 模型 | 用途 |
| --- | --- |
| `BriefWatchPool` | 观察池：重点商品/类目 |
| `OperationBrief` | 经营日报/简报 |
| `OperationBriefRun` | 日报生成运行记录 |

## 6. 信息架构与页面映射（前端布局改造依据，Q13a/Q14a）

路由：`/commerce-platform`（商品运营）与 `/operations-briefing`（经营情报），同步 `PlatformSwitcher`、检查脚本与文档链接。

| 页面（零售） | 内容 | 阶段 |
| --- | --- | --- |
| 首页经营工作台 | 3 个零售示例 prompt（§6.1） | P4 |
| 商品运营（`/commerce-platform`） | 商品池（SKU 搜索/筛选/标签）、商品详情（日销/流量/转化时序）、类目流量与转化、零售指标目录、零售业务知识、基础组件（数据窗口/类目树/口径） | P6 |
| 经营情报（`/operations-briefing`） | 经营情报中心（日报） | P7 |
| `PlatformSwitcher` 标签 | 经营工作台/商品运营/经营情报 | P4 |
| `ToolResultItem` | 零售结果渲染（含合成口径徽标） | P4 |
| `api/commerce/` 5 条路由（P0 已改名） | 零售语义（含 entity resolve：SKU/类目解析） | P3/P4 |

### 6.1 首页示例 prompt（待确认项 B）

1. "数据窗口内 GMV 最高的 5 个类目是哪些？给出各类目的转化率和客单价对比。"
2. "从浏览、收藏、加购到购买的转化情况怎样？哪个环节流失最大，集中在哪些类目？"
3. "库销比最差的 10 个商品是哪些？它们的流量转化情况如何？"

### 6.2 零售指标目录 v1（对应指标目录页，待确认项 C）

曝光量、浏览用户数、收藏率、加购率、购买转化率（buy/pv）、GMV、客单价（GMV/buy）、动销率（有 buy 的 SKU 占比）、库销比（库存/日销）、类目集中度（top-5 类目 GMV 占比）。

## 7. Agent 行为与领域包（P3）

- **注册**：`src/lib/domains/retail/` 按 `docs/data-agent-architecture.md` 七步法建设；Registry + ApplicationCatalog 注册后，`DEFAULT_DATA_AGENT_PROFILE_ID` 指向 `shopgate.retail-ops`。
- **query-rewrite 领域约束**：沿用 schema v4 语义合同——时间范围、商品/类目范围、answer-only 意图必须有原文字面证据；实体解析（SKU/类目）独立确认，模型不可用时停止规划，不以关键词结果冒充成功。
- **实体 Resolver**：商品（item_id/标题模糊）与类目（category_id/合成类目名）两级解析。
- **工具**：`commerce_api_get`（P0 已改名）+ commerce-data 领域接口；capsules `requiresTools` 已同步。
- **高危点**：`src/lib/services/pi-agent-prompts.ts` 系统提示词保持零售文案（有测试对照）。
- **module-boundaries**：登记 `retail-domain` 模块（`src/lib/domains/retail/**`）与跨域禁令。

## 8. 验收标准

### 8.1 最小闭环（Q8a，P5 验收）

1. `npm run db:up && npm run db:init` 成功，`commerce.*` 表就绪；
2. 导入脚本完成：抽样行为流（~100 万事件）+ 合成主数据入库，日聚合物化；
3. `npm run dev` 启动，首页为经营工作台（零售示例 prompt）；
4. AI 工作台提出 §6.1 中任一自然语言问题 → Agent 生成零售 dashboard（预览可用，金额处带合成口径徽标）；
5. `docs/prd.md` 之外的门：`type-check`、vitest（≤基线+已归因）、后端 ruff/pytest、`check:skills`、模块边界检查全绿。

### 8.2 文案归零门（P4/P6 各自执行）

首页与商品运营平台页面源码中历史遗留的非零售文案计数为 0（`grep -riE` 词表检查，排除注释），金额处均带合成口径标注。

## 9. 风险与开放问题

| # | 风险/开放项 | 处理 |
| --- | --- | --- |
| R1 | 天池数据集下载需账号登录 | P2 时由用户手动下载 CSV 到本地路径（脚本接受路径参数）；兜底：公开镜像或先全合成跑通 |
| R2 | 9 天时间窗限制长周期洞察（复购/趋势） | 日报与趋势以日粒度 + 窗口内口径；二期扩展窗口或换数据集 |
| R3 | 合成金额被误读 | §5.3 红线：徽标 + tooltip + 回答话术约束 |
| R4 | UserBehavior 口径偏用户行为（无订单/支付字段） | GMV 用 buy×合成价格；PRD 明示口径 |
| R5 | 抽样偏差（10k 用户） | 指标以率与结构为主，绝对量仅作演示；PRD 明示 |

## 10. 待确认项（签字时一并拍板）

| 项 | 提案 | 备选 |
| --- | --- | --- |
| A. 抽样规模 | 10,000 用户全量行为（~100 万事件） | 1,000 用户（更快）/ 50,000 用户（更重） |
| B. 首页示例 prompt | §6.1 三条 | 用户自拟 |
| C. 指标目录 v1 | §6.2 十项 | 增删由用户圈定 |
| D. 路由命名 | `/commerce-platform`、`/operations-briefing`（P4 一次到位） | 保留原路由名只换内容（链接/文档改动最小） |

## 11. 里程碑映射

| 阶段 | 本文档依据 | 验收 |
| --- | --- | --- |
| P2 数据切片 | §5 全部 | 导入成功 + 接口 curl + 日聚合物化 |
| P3 领域包 | §3、§7 | 默认 Profile 指向 `shopgate.retail-ops` + 门绿 |
| P4 前端切片 | §6（首页/导航/ToolResultItem/商品池最小页/情报占位/路由） | dev 可用 + §8.2 归零门 |
| P5 闭环验收 | §8.1 | 用户验收 |
| P6/P7/P8/P9/P10 | §3.1–3.4 全量、§6 映射表余项、skills、评测、docs | 各自阶段门 |
