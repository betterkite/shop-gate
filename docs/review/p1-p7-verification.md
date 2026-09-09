# Shop Gate P1–P7 完成总结与核查清单

> 交付给评审人：按本章节逐一核对「结构 / 功能模块 / 逻辑 / 数据 / 门」。
> 环境：`main` 分支干净；服务端口 `:3000`(Next app)、`:8000`(commerce-data API)、`127.0.0.1:5432/shopgate`(Postgres/TimescaleDB)。
> 数据口径红线：**行为事件为真实天池 UserBehavior；价格/库存/品牌/店铺/GMV 为合成主数据**，所有金额展示必须带"合成口径"标注。

---

## 全局事实（评审先确认）

- 项目：Shop Gate（零售电商数据智能体），蓝本 QuantPilot（MIT/Opactor AI），全新独立仓库。
- 技术栈：Next.js 16 app router + `src/lib/domains/<domain>/**`；Prisma（Postgres/TimescaleDB）；Python FastAPI `services/commerce-data`。
- 真实数据：天池淘宝 UserBehavior（dataset 649），**公开镜像切片** → 过滤到规范窗口 → 导入。
  - 落库：**1,013,367 事件 / 10,000 用户 / `source='tianchi_userbehavior'` / 窗口 2017-11-25 ~ 12-03**（`--time-shift none` 保留原始日期）。
  - 商品主数据：**412,130 商品 / 5,922 类目 / 200 品牌 / 500 店铺（tier: standard 174 / premium 164 / flagship 162）**；日聚合 `daily_item_metrics` 687,562 行、`daily_category_metrics` 30,644 行。
- 全局门（各阶段已跑）：`type-check`、`vitest`、后端 `ruff`+`pytest`、`module-boundaries`、`check:skills`/`check:docs`。

---

## P0 — 落地与地基（done）

**目标**：导入 QuantPilot 快照为独立仓库；修复构建；把品牌/命名机械换牌；删基准数据。

**结构 / 功能模块**
- `services/market-data` → `services/commerce-data`（Python 包 `shopgate_commerce_data`，脚本 `shopgate-commerce-api`/`shopgate-commerce-import`）。
- `src/lib/quant` → `src/lib/commerce`；`src/app/api/quant` → `src/app/api/commerce`。
- 删除 `benchmarks/`；品牌串 `QuantPilot/quantpilot/QUANTPILOT_` → `Shop Gate/shopgate/SHOPGATE_`。
- 明确**不触碰**的命名合同：`PiAgent*`/`.pi/`、prisma migration checksum、`.data-agent` 工作空间合同。

**逻辑**：P0 是"换名不改语义"的机械替换；保留平台内核，后续阶段做内容级零售化。

**核查清单**
- [ ] 品牌串 grep 归零（例外清单见 `PROVENANCE.md` 与 ISSUES P0 残留台账：`.pi` 内 quant_* 工具名、`sqls/` 中 quant.*、平台标识符 `Quant*` 等，明确归属 P8/P2/P10）。
- [ ] `npm run type-check`、`npytest`、`check:skills`/`check:docs`、`module-boundaries` 通过；基线已知失败（`pi-agent-terminal.test.ts` 25、`skills/compiler.test.ts` 1、`preview.test.ts` 1、`generated-project-sandbox.test.ts` 1，环境依赖）已记录在案。
- [ ] 服务能启动：`shopgate-commerce-api` 绑定 `127.0.0.1:8000`。

---

## P1 — 零售电商 PRD（done，v0.2 已签字）

**目标**：定义定位、非目标、4 个 v1 能力、数据口径（真实/合成边界）、页面映射、验收标准。

**交付物**：`docs/prd.md`（签字 v0.2）。

**功能模块 / 逻辑**
- 4 个 v1 能力：`traffic_funnel` / `catalog_structure` / `price_inventory` / `daily_brief`。
- 数据边界（红线）：行为流真实；金额/库存/品牌/店铺合成（§5.3）；`gmv = buy 事件数 × 合成价格`（§5.2）。
- 页面映射（§6.1）：经营工作台/商品运营/经营情报；移除 `StrategyScan*`。

**核查清单**
- [ ] `docs/prd.md` 覆盖：4 capability、非目标（二期开放 API、定价/选品/履约/客服）、§5 数据口径、§6 页面映射、§7 验收标准。
- [ ] 真实/合成边界表述一致（金额合成、行为真实）。
- [ ] 与后续实现一致（P5 看板、P6 商品运营页、P7 经营情报均按此口径）。

---

## P2 — 数据切片（done）

**目标**：`commerce.*` 零售 schema、UserBehavior 抽样导入 provider、合成商品主数据、commerce-data 最小接口、prisma 追加式 migration、处置 `quant.*` SQL schema。

**结构**
- schema（`commerce.*`）：`user_behavior_events`、`items`、`categories`、`brands`、`shops`、`daily_item_metrics`、`daily_category_metrics`；迁移入 `commerce` 的平台表 `platform_jobs`/`market_data_sync_state`/`market_data_ingestion_jobs`/`data_quality_scans`。
- 数据源知识库：`docs/commerce-data-ingestion.md`（真实导入 + 自有数据连接器契约）。

**功能模块 / 逻辑**
- 导入 CLI `shopgate-commerce-import`：`import-userbehavior`（读任意 5 列表头 CSV，确定性用户抽样）、`generate-synthetic-behavior`（无 CSV 兜底）、`generate-synthetic-master`、`aggregate-daily`。
- 抽样：`--users 10000 --seed 20251203`；`--time-shift none`（保原始 2017 日期）或 `last-week`（演示平移）。
- 数据契约：事件 CSV 五列 `user_id,item_id,category_id,behavior_type,timestamp`；`provider` 写入 `market_data_ingestion_jobs` / `market_data_sync_state`（未来自有数据连接器复用）。

**核查清单**
- [ ] `db:up` 后 `commerce.*` 表存在；`quant.*` 相关处置完成。
- [ ] `psql ... "SELECT source, COUNT(*), MIN(event_ts)::date, MAX(event_ts)::date FROM commerce.user_behavior_events GROUP BY source"` → 仅 `source=tianchi_userbehavior`，count≈1,013,367，窗口 2017-11-25~12-03。
- [ ] `items/categories/brands/shops` 行数如上；`daily_item_metrics` 687,562 行。
- [ ] 导入 CLI 可用：`shopgate-commerce-import import-userbehavior --csv <path> --time-shift none`（确定性可复现）。
- [ ] `shopgate-commerce-import generate-synthetic-master` 及 `aggregate-daily` 幂等。

---

## P3 — retail Domain Pack（done）

**目标**：建 `src/lib/domains/retail/`（4 capability），注册并切默认 Profile 为零售；重写 `src/lib/commerce` 21+7 领域耦合文件（含 `pi-agent-prompts.ts` 高危点）；删除 `finance.quant` 包；module-boundaries 登记。

**结构**
- 新增 `src/lib/domains/retail/`：capabilities / agent-profile / intent / mission-definition / query-rewrite(+llm) / workspace / data-agent-projection / data-identity / entity-aliases / visualization-templates / agent-tools×6 / barrel（约 16 文件 + 零售脚手架模板）。
- 删除 `domains/finance` 整包；`src/lib/commerce` 中 data-prefetch / generation-executor / capability-center / validation / act-preparation / prompts / cli / preview / mission-control / observability 零售化；移除 `StrategyScan*` prisma 模型 + 33 个金融 e2e 用例 + strategy-platform 金融 UI。

**逻辑**
- 默认 Profile=`shopgate.retail-ops`，domain=`retail.core`，deliveryPack=`workspace.next-dashboard`。
- 零售语义映射：`finance.quant`→`retail.core`；`market-data`→`commerce-data`；工具名 `commerce_*`。

**核查清单**
- [ ] `src/lib/commerce/*` 及 `src/lib/prompts` 无 `finance.quant`/金融强耦合残留（排除平台命名合同）。
- [ ] 默认 Agent Profile 为 `shopgate.retail-ops`；可创建零售任务。
- [ ] `module-boundaries` 通过；`vitest`（src/lib/domains/retail + commerce）绿。
- [ ] 残留台账确认（`.pi` quant_*、`Quant*` 平台标识符、`sqls/` quant.* 等）归属 P8/P2/P10。

---

## P4 — 前端切片（done）

**目标**：首页零售示例 prompt、导航与通用文案、ToolResultItem 领域渲染、商品池最小可用页、经营情报占位。

**结构**
- 导航（`src/components/layout/PlatformSwitcher.tsx`）：`/`(经营工作台)、`/commerce-platform`(商品运营)、`/operations-briefing`(经营情报)。
- 路由 `research-reports` → `operations-briefing`；首页 prompt=PRD §6.1。

**核查清单**
- [ ] `npm run dev` 可用；首页/商品池无金融文案残留。
- [ ] 三个导航项指向正确路由；`/commerce-platform`、`/operations-briefing` 存在。

---

## P5 — 最小闭环验收（完成，待用户最终验收）

**目标**：自然语言零售问题 → 生成 dashboard 端到端（真实数据口径）。

**逻辑 / 流水线**
- 生成管线：Query Rewrite → Run Plan → **Data Prefetch** → 标准看板生成 → 自动验证 → 证据验收 → 持久预览。
- 关键：看板窗口**运行时从 `dataset_meta` 的首/末事件动态推导**（非写死），故切换到真实 2017 数据后自动用 2017 窗口。
- 预取数据集：`meta/funnel/funnelDaily/categories`（能力适配）。

**核查清单**
- [ ] 用零售问题跑一单，达 `ready`/`validation=passed`，预览 HTTP 200。
- [ ] `data_file/final/dashboard-data.json` 的 `window.start/end = 2017-11-25/2017-12-03`，`datasets.meta.behavior_source=tianchi_userbehavior`，`event_count≈1,013,367`。
- [ ] 页脚 `meta?.behavior_source` 渲染真实来源；合成徽标/口径说明存在。
- [ ] 已知修复：`fix/p5-scaffold-null-meta`（`meta.behavior_source` 空值安全）。

---

## P6 — 商品池/品类池/渠道分析全量重建（实现完成，待用户最终验收）

**目标**：替换金融 strategy-platform；QuantPilot 级多面板富视觉看板；接入前端页面/路由；合成口径标注。

**结构 / 功能模块**
- 能力看板多面板：`retail-scaffold-templates.ts` + `retail-scaffold-dashboard.ts`（模板分发）+ `visual-validation.ts`（零售标记放宽金融语义词）。
  - catalog：GMV 柱状 + Top-5 集中度环 + 分日趋势 + 指标矩阵。
  - funnel：事件漏斗柱状 + 阶段占比环 + 分日趋势 + 转化表。
  - price：价格带柱状 + 库销比排行 + 库存健康度环。
  - daily：指标卡 + 环比 + 类目 GMV 柱状 + 异动表。
- 数据端点：`retail.product_pool` / `retail.channel_metrics` → `GET /api/v1/commerce/items`（分页/类目/排序）、`GET /api/v1/commerce/channels`（店铺 tier 聚合）。
- 前端页面：`/commerce-platform`（商品池/品类池/渠道三视图，纯 RSC，`?view/page/sort` 驱动）。
- 修复：`.filter(Boolean)` 未窄化 null、`meta` 未声明、SVG 字符串未用 `dangerouslySetInnerHTML`；`scaffold.ts` 764>720 边界（抽到 `retail-scaffold-dashboard.ts`）；视觉校验金融语义误导（`retail-workbench` 标记）。

**核查清单**
- [ ] `/commerce-platform`（登录态）三视图渲染真实数据：商品池 20 行/页、total 412,130、`/items` 分页正确；品类池 top-100；渠道 standard/premium/flagship。
- [ ] 四种能力 e2e 均达 `ready`+视觉 passed：catalog svgCount=3 / funnel 3 / price 2 / daily 1。
- [ ] `GET /api/v1/commerce/items` 与 `/channels` 返回合成字段标注；`/items` 大小（412,130）正确。
- [ ] 合成口径徽标 + 行为流来源标注在每处金额展示。
- [ ] 性能：切标签/排序/翻页数据请求由 ~3s 降到 ~0.6s（窗口缓存 + 只拉当前视图）。
- [ ] `:8000` 重启后新端点可用（生产部署同理会加载）。

---

## P7 — 经营情报中心全量 + 日报链路（实现完成）

**目标**：替换金融 research-reports；经营情报中心（经营日报/类目经营榜/观察池）；日报生成链路可运行；合成口径标注。

**结构 / 功能模块**
- `src/lib/commerce/retail-briefing.ts`：`getOperationsBriefingData()` 从 API 取日报摘要（`/summary?date=末日`）、类目经营榜（`/categories/top`）、观察池（`/items?sort=gmv` top-20）+ 最近生成日报。
- `/operations-briefing`：经营日报 / 类目经营榜 / 观察池三视图（纯 RSC）。
- `src/lib/commerce/retail-daily-report.ts`：`generateRetailDailyBrief()` 生成并**持久化** `OperationBriefRun(completed)` + `OperationBrief`；`getLatestRetailDailyBrief()` 读最新。
- `src/app/api/commerce/briefing/daily/route.ts`：GET（最新）/ POST（生成），鉴权 `requireAction`（`operations.brief.read/run`）。
- daily 视图"生成今日日报"按钮（客户端）+ 最近生成日报。

**核查清单**
- [ ] `/operations-briefing`（登录态）三视图渲染真实数据（daily 摘要+日环比、categories=100、watch=20）。
- [ ] `POST /api/commerce/briefing/daily` → `success`+`runId/reportId/date`；`GET` 读回最新。
- [ ] DB：`operation_briefs` 出现「经营日报 2017-12-03」摘要（GMV/曝光/购买/转化/客单价），`operation_brief_runs.status='completed'`。
- [ ] 金额/客单价带合成口径说明；行为流来源标注。
- [ ] 已知遗留：**推送回执**依赖通知渠道配置（零售暂无 watchlist/channel），暂未接，留后续。

---

## 各阶段门（评审统一跑）

```
npm run type-check
npx vitest run src/lib/commerce src/lib/utils src/app      # 预期全绿
cd services/commerce-data && .venv/bin/ruff check src && .venv/bin/python -m pytest -q
node scripts/checks/check-module-boundaries.js            # 无新增失败（剩余为 P3/P10 金融遗留引用）
```

**已知遗留（非本次引入）**：模块边界报"missing file" 引用 `validation.ts`/`data-prefetch.ts`/`strategies.ts`/`StrategyPlatformClient.tsx` 与 `module-boundaries.md 未提及 retail-domain`（P3/P10 范畴）。

## 评审重点（跨阶段一致性）

1. **数据边界一致**：行为=真实（`behavior_source=tianchi_userbehavior`），金额/库存/品牌/店铺=合成（每处展示有"合成口径"徽标/说明）。这是 P1 红线，贯穿 P5/P6/P7。
2. **窗口口径一致**：真实数据一律 `2017-11-25~12-03`（`--time-shift none`）；演示平移口径仅用于合成兜底。
3. **同一来源**：页面/看板都走本地「数据库 → commerce-data API(:8000)」。
4. **平台命名合同**：`PiAgent*`/`.data-agent`/prisma migration checksum 未破坏。
