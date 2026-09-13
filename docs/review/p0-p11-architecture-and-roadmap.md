# Shop Gate P0–P11 架构·验收·演进总览

> 面向评审与后续迭代。每阶段给出：设计结构 / 功能模块 / 核心逻辑 / 验收清单 / 遗留。
> 数据红线（贯穿全程）：**行为事件=真实天池 UserBehavior；价格/库存/品牌/店铺/GMV=合成主数据**，金额处必须带"合成口径"标注。
> 交付分支：`main`（P0–P11 全部合入）。

---

## 0. 全局架构（P0–P11 之后的最终形态）

```
浏览器 / 预览（:3000 Next.js app router）
   │  页面：/(经营工作台)  /commerce-platform(商品运营)  /operations-briefing(经营情报)
   │        /skills  /eval-platform  /ops-platform  /admin  /login
   │
   ├── src/lib/domains/retail/**     ← 零售 Domain Pack（唯一领域内核）
   │     capabilities(4) · agent-profile(shopgate.retail-ops) · query-rewrite(+LLM)
   │     run-planner · intent · data-identity · entity-aliases
   │     agent-tools×6 · visualization-templates · data-agent-projection
   │
   ├── src/lib/commerce/**           ← 零售域业务服务（数据/校验/情报）
   │     retail-act-preparation · retail-data-prefetch · retail-generation-executor
   │     retail-validation(3139行) · retail-briefing · retail-daily-report
   │     retail-capability-center · research-reports · skills-*
   │
   ├── src/lib/generation/**         ← 生成编排纯平台机制（P11 迁入）
   │     产物契约 · 队列 · 状态 · 终端投影 · 修复收敛 · 工作区健康/进度/响应
   │     证据 · 通知适配 · runtime/terminal 测试
   │
   ├── src/lib/agent/**              ← PI Agent 内核（上游合同，未改）
   │     Skills 编译 · capsule · 命名策略(scope=quant/commerce/platform/workflow…)
   │
   ├── src/lib/eval/**               ← 评测框架（机制层保留；金融语料部分待零售语料）
   │
   └── services/commerce-data/**     ← Python FastAPI（:8000）零售数据后端
        routers/commerce(/meta /resolve /capabilities /funnel[/daily] /categories/top
        /items /items/{id}/daily /inventory-risk /channels /summary)
        retail.py(product_pool/channel_metrics/dataset_meta/…) + import_cli
        数据：PostgreSQL/TimescaleDB `commerce.*`
```

**数据流**（真实校验闭环）：

```
公开镜像 UserBehavior CSV → shopgate-commerce-import（真实事件+合成主数据）
   → commerce.*（:5432）→ commerce-data API（:8000）
        → ① /commerce-platform 实时取数渲染
        → ② 生成管线：Query Rewrite(LLM) → Run Plan → 预取 → dashboard-data.json
             → 多面板看板模板 → next build → 自动验证 → 视觉验收 → receipt → 预览(:4129…)
        → ③ 日报链路：/summary+类目榜 → OperationBrief 持久化 → GET/POST 路由
```

---

## P0 — 落地与地基（done）

**结构**：`services/market-data`→`commerce-data`；`src/lib/quant`→`src/lib/commerce`；`src/app/api/quant`→`src/app/api/commerce`；删 `benchmarks/`。
**功能模块**：品牌/命名机械换牌；基线测试归因。
**逻辑**：换名不改语义；平台内核（PI Agent/`.data-agent`/prisma migration）为命名合同不可触碰。
**验收清单**
- [ ] `src`/`config`/`sqls`/`public`/`electron` 品牌串 = 0（P10 复核确认）。
- [ ] `check:skills`/`check:docs`/`type-check`/`pytest` 通过；基线已知失败（pi-agent-terminal 25、compiler 1、preview 1、sandbox 1）在案。
- [ ] `shopgate-commerce-api` 可启动并绑定 :8000。
**遗留**：`.pi` 内 quant_* 工具名（P8 已清）、`Quant*` 平台标识符（P10 已清显示层）、`sqls/` quant.*（P2 已处置）。

## P1 — 零售 PRD（done，v0.2 签字）

**交付物**：`docs/prd.md`。
**功能模块**：4 能力（traffic_funnel/catalog_structure/price_inventory/daily_brief）；非目标（开放 API/定价/履约=二期）；数据口径 §5.1–5.3；页面映射 §6.1。
**逻辑红线**：行为真实、金额合成、`gmv=buy×合成价`。
**验收清单**：[ ] 覆盖上述章节；[ ] 与 P5–P7 实现一致；[ ] 红线贯穿（P5/P6/P7 均有合成徽标）。

## P2 — 数据切片（done）

**结构**：`commerce.*` 七张业务表 + 4 张平台表迁入 commerce schema。
**功能模块**：导入 CLI 4 命令（import-userbehavior/generate-synthetic-behavior/generate-synthetic-master/aggregate-daily）；数据源知识库 `docs/commerce-data-ingestion.md`（真实导入+自有数据连接器契约）。
**逻辑**：5 列 CSV 契约（user_id/item_id/category_id/behavior_type/timestamp）；provider 书签（ingestion_jobs/sync_state）；确定性抽样（seed=20251203）。
**验收清单**
- [ ] `commerce.user_behavior_events`：1,013,367 事件/10,000 用户/2017-11-25~12-03/`tianchi_userbehavior`。
- [ ] `items` 412,130 / `categories` 5,922 / `shops` 500（tier 三档）/ `daily_item_metrics` 687,562。
- [ ] CLI 确定性复现；`/meta /funnel /categories/top /summary` 等 API 200。

## P3 — retail Domain Pack（done）

**结构**：`src/lib/domains/retail/**`（16 文件）；删 `domains/finance`；`src/lib/commerce` 21+7 文件零售化；删 StrategyScan* + 33 金融 e2e。
**功能模块**：capabilities(4)/agent-profile(`shopgate.retail-ops`)/query-rewrite(+LLM)/run-planner/intent/data-identity/entity-aliases/visualization-templates/agent-tools×6。
**逻辑**：默认 Profile=shopgate.retail-ops、domain=retail.core、delivery=workspace.next-dashboard；`finance.quant`→`retail.core`。
**验收清单**：[ ] 无 finance.quant 残留；[ ] 默认 Profile 零售；[ ] 可创建零售任务；[ ] module-boundaries 绿（当时基线）。

## P4 — 前端切片（done）

**结构**：导航三入口（`PlatformSwitcher`：/ /commerce-platform /operations-briefing）；`research-reports`→`operations-briefing`。
**验收清单**：[ ] dev 可用；[ ] 首页/商品池无金融文案（P10 终审后全零）。

## P5 — 最小闭环（done，待用户验收）

**结构**：Query Rewrite(LLM)→Run Plan→**Data Prefetch**（动态窗口取自 dataset_meta）→标准看板→自动验证→证据验收→持久预览。
**功能模块**：`retail-act-preparation`/`retail-data-prefetch`/`retail-generation-executor`/`retail-validation`/`visual-validation`。
**逻辑**：跳过 Agent 的确定性标准看板；模板按能力分发（P6a 补齐）；验证链全确定性（build/HTTP/数据文件/evidence/图表/来源）。
**验收清单**
- [ ] 零售问题 → `ready`/`validation=passed`/预览 200。
- [ ] `dashboard-data.json`：window=2017-11-25~12-03、behavior_source=tianchi_userbehavior、event_count≈1,013,367。
- [ ] 页脚来源 + 合成徽标；样例 `project-e2e-retail-e2e-2-r01`（svgCount 3）。
**遗留**：R01 类 catalog case 偶发输出 token 预算达成（变量性）；skill 脚本功能级零售化（→P9 遗留）。

## P6 — 商品池/品类池/渠道 + 富看板（实现完成，待用户验收）

**结构 / 功能模块**
- 四能力多面板模板（`retail-scaffold-templates.ts`）+ 分发器（`retail-scaffold-dashboard.ts`）：
  catalog(柱+环+趋势+矩阵)、funnel(柱+阶段环+趋势)、price(价格带+库销比表+健康环)、daily(指标卡+环比+类目柱+异动表)。
- 数据端点：`GET /items`（分页/类目/排序）、`GET /channels`（店铺 tier 渠道聚合）。
- 页面 `/commerce-platform`（商品池/品类池/渠道三视图，RSC，`?view/page/sort`）。
**逻辑**
- 标准生成按 capability 分发能力模板（`writeRetailDashboardTemplate`）；
- 视觉校验对 `data-visual-language="retail-workbench"` 放宽金融语义强制（修 repair 回退）；
- SVG 经 `dangerouslySetInnerHTML` 注入（svgCount 3/3/2/1）。
**验收清单**
- [ ] `/commerce-platform` 三视图真实数据（商品池 20 行/412,130、品类池 100、渠道 3 tier）。
- [ ] 四能力 e2e `ready`+visual passed（svgCount 3/3/2/1）。
- [ ] `/items` total=412,130 且含 synthetic_fields；`:8000` 需重启加载新端点。
**遗留**：改名 skill body/scripts 功能零售化；visual 检查排查（见遗留汇总）。

## P7 — 经营情报中心 + 日报链路（实现完成）

**结构 / 功能模块**：`retail-briefing.ts`（日报摘要/类目榜/观察池）+ `/operations-briefing` 三视图；`retail-daily-report.ts`（生成并持久化 OperationBrief/OperationBriefRun）+ `GET/POST /api/commerce/briefing/daily` + "生成今日日报"按钮。
**逻辑**：日报=窗口末日快照（GMV/转化/客单价+日环比）；持久化后可检索。
**验收清单**
- [ ] 三视图真实数据（daily 摘要+环比、categories=100、watch=20）。
- [ ] POST→runId/reportId、GET 读回、`operation_briefs` 落库「经营日报 2017-12-03」、run status=completed。
**遗留**：推送回执依赖通知渠道配置（零售暂无 watchlist/channel）。

## P8 — Skills 零售化与清洗（done）

**结构 / 功能模块**：12 核心 skill；`quant-*`→`commerce-*` 六个领域 skill 改名（major 原子）；`scenario_templates.md` 补 4 零售场景段；finance-*→retail-* 路径清洗；品牌词/quant_ 工具名归零；新增 `commerce` scope 命名策略。
**逻辑**：skill=版本化发布物，发布流=改源→registry/changelog→package:skills→不可变版本快照→check:skills。
**验收清单**
- [ ] `check:skills` 绿（12 skills + 14 scripts）。
- [ ] `.pi` 品牌词/quant_ 工具名/finance-* 路径归零（grep 0）。
- [ ] 6 个 commerce-* skill 版本快照与包 sha256 一致。
**遗留**：改名 skill body/scripts 仍金融计算逻辑（功能零售化归 P9 后续）。

## P9 — 评测与 e2e 基准重建（done，三项验收达成）

**结构 / 功能模块**：`config/evals/task-e2e-retail-v1.json`（30 零售 case）+ `check-task-e2e-campaign.ts --dataset=` + `check-retail-e2e-benchmark.js`（真实校验：数据集结构+最近运行证据）+ 6 个金融 eval 入口/runner 改为零售校验委托。
**逻辑**：金融 eval 数据体系（判官校准/生产回放/变异语料）无零售输入不可重建 → 归档；零售真实校验=零售 task-E2E 基准（确定性契约对错判定）。
**验收清单**
- [ ] `--dataset=task-e2e-retail-v1 --limit=1/4` → R01 READY + R02/R03/R04 READY。
- [ ] `check:retail-e2e` 绿（30 case/4 能力/ready=3/4 证据）。
- [ ] 6 入口 + runner exit 0 且执行零售校验（不再静默 SKIPPED）。
**遗留**：判官校准/变异/生产回放待零售语料后按 A 路线重建（机制层已保留）。

## P10 — docs/README 终审（done）

**结构 / 功能模块**：运行时文案归零（67→0）；`.pi` changelog 品牌词归零（30→0）；4 篇金融文档归档横幅；module-boundaries 补登 retail-domain；视觉检查断言旧文案→Skills Market。
**验收清单**
- [ ] `src` 量化/投研/股票=0；`.pi`/`config`/`sqls`/`public`/`electron` 品牌词=0。
- [ ] 品牌残留仅出处/历史记录（PROVENANCE/PRD 来源说明/review 历史/归档横幅）。
- [ ] `check:docs` 54 文件 282 链接绿。
**遗留**：`ops-platform-guide` 保留但 quant.* 标注金融遗留；`strategy-platform` 等归档文档待后续删除或深化零售化。

## P11 — 平台文件迁移（done，可选阶段）

**结构**：`src/lib/generation/**`（18 平台模块 + 11 测试）；`src/lib/commerce` 仅零售域（7 retail-* + research-reports + skills-* 等）。
**功能模块**：产物契约/队列/状态/终端投影/修复收敛/工作区健康·进度·响应/证据/通知适配。
**逻辑**：纯平台机制与零售域物理分层；`quant-core.paths += src/lib/generation/**`；4 个过时 largeFileBudget 修复（清零 missing-file 失败）。
**验收清单**
- [ ] `generation/` 29 文件；`commerce/` 零残留；零售域保留。
- [ ] type-check/check:skills/check:retail-e2e/module-boundaries/vitest 全绿（仅基线 28）。

---

## 遗留问题汇总（按优先级）

| # | 遗留 | 影响 | 建议归属 |
| --- | --- | --- | --- |
| 1 | `check-skills-visual`/`check-platform-visuals` 视觉检查失败 | 无法验证 UI 视觉 | P10 后排查（登录态/定位器/页面状态） |
| 2 | R01 类 catalog case 偶发"输出 token 预算达成" | 基准 flaky | 调 agent 输出预算/重试策略 |
| 3 | `retail-validation.ts` 3139 行（预算 3140 警告） | 维护性 | 按 artifact/data contract/visual/repair/acceptance 拆分 |
| 4 | 改名 skill 的 body/scripts 金融计算逻辑 | 功能正确性 | 按零售语义重写（P9 后续） |
| 5 | 判官校准/变异/生产回放缺零售语料 | 评测深度 | 零售语料产生后按 A 路线重建 |
| 6 | 日报推送回执依赖通知渠道配置 | 日报触达 | 配置通知渠道后接通 |
| 7 | module-boundaries 4 个 missing-file 引用已清零，但 `retail-domain` 的 publicSurface 仍指 `@/lib/domains/finance` | 配置正确性 | P10 后修正 |
| 8 | `docs/strategy-platform-guide` 等归档文档 | 文档噪音 | 后续删除或深化零售化 |

---

## 迭代进化路线

### 近期（巩固，1–2 个迭代）
1. **视觉检查排查**（遗留#1）：登录态/定位器/页面状态诊断，恢复 UI 视觉回归能力。
2. **基准稳定性**（遗留#2）：catalog case 输出 token 预算调优 + 失败重试，降低 flaky。
3. **retail-validation 拆分**（遗留#3）：消除 3139 行大文件警告，按管线分段拆模块。
4. **skill 脚本功能零售化**（遗留#4）：把 6 个 commerce-* skill 的 scripts 从金融计算改为零售逻辑（数据注册/实体解析已对齐；rule-review/metrics 需按零售指标重写）。

### 中期（能力补齐）
5. **日报触达**（遗留#6）：配置企业微信/邮件渠道 → 日报生成后真实推送 + 回执。
6. **观察池产品化**：观察池从"top-20 派生"升级为用户可管理的 `BriefWatchPool`（增删/阈值/订阅）。
7. **零售判官 v1**（遗留#5 前置）：用规则化 rubric（必备组件/图表/标注/口径，加权打分）先行，替代"需要黄金集"的判官。
8. **数据扩展**：接第二零售数据源（验证 `docs/commerce-data-ingestion.md` 连接器契约的可插拔性）。

### 长期（体系升级）
9. **判官校准/生产回放重建**（遗留#5）：零售语料与真实流量积累后，按 A 路线重建完整评测体系。
10. **模型对比评测**：多模型（DeepSeek/Qwen/本地）在零售基准上的 passRate 对比。
11. **权限体系零售化**：`quant.*` 权限 key → `commerce.*`（涉及 DB/配额迁移，需单独迁移方案）。
12. **P11 深化**：retail-validation 拆分后，将 retail-* 中剩余平台职责继续下沉 generation。

### 建议迭代节奏
- 每迭代：1 个能力增强 + 1 个技术债清偿 + 全部门（type-check/check:skills/check:retail-e2e/check:docs/vitest/module-boundaries）+ 零售基准回归（`--limit=4`）。
- 验收关口：新增能力必须带确定性契约校验（对/错），主观质量分层（rubric/判官）作为后续增强，不阻塞门。
