# Shop Gate 交接文档（P0–P11 全量工作 · 交接版）

> 交接日期：2026-09-08 · 基线：`main` @ `16934ac`
> 适用读者：接手开发 / 评审 / 运维
> 配套文档：[P1–P7 核查清单](p1-p7-verification.md) · [P0–P11 架构与演进](p0-p11-architecture-and-roadmap.md)

---

## 0. 项目是什么

**Shop Gate**：零售电商领域的 Data Agent 工作台。运营者/分析师用自然语言提出经营问题，Agent 组合零售领域知识、真实行为数据与 Skills，生成可运行、可追溯的零售经营看板。

- 蓝本：QuantPilot（MIT，金融域），已全面零售化（金融域 P3 删除，skill/文案/文档已清）。
- 技术栈：Next.js 16 app router + Prisma(PostgreSQL/TimescaleDB) + Python FastAPI。
- **数据红线**：行为事件=真实天池 UserBehavior；价格/库存/品牌/店铺/GMV=合成主数据；金额处必须带"合成口径"标注。

## 0.1 本地启动与访问

```bash
npm run dev          # :3000 应用
docker compose up -d # Postgres(:5432)
cd services/commerce-data && shopgate-commerce-api   # :8000 数据后端
```

**登录凭证（本地）**：`admin@shopgate.local` / `shopgate2025`（来自 `.env.local` 的 `SHOPGATE_AUTH_ADMIN_*`）。
**关键**：`.env.local` 或 `.env` 改动、`services/commerce-data` 源码改动后，**必须重启 :8000**（否则数据端点不更新）。

---

## 1. 各阶段工作明细（结构 / 功能模块 / 逻辑）

### P0 落地与地基
- **结构**：`services/market-data`→`commerce-data`；`src/lib/quant`→`src/lib/commerce`；`src/app/api/quant`→`/api/commerce`；删 `benchmarks/`。
- **逻辑**：机械换名不改语义；平台命名合同（`PiAgent*`/`.data-agent`/prisma migration checksum）不可触碰。
- **验收**：品牌串归零（出处记录除外）；基线失败归因。

### P1 零售 PRD
- **交付**：`docs/prd.md` v0.2（已签字）。
- **核心**：4 能力（traffic_funnel/catalog_structure/price_inventory/daily_brief）；红线 gmv=buy×合成价；页面映射。

### P2 数据切片
- **结构**：`commerce.*`：user_behavior_events/items/categories/brands/shops/daily_item_metrics/daily_category_metrics + 4 平台表。
- **模块**：`shopgate-commerce-import` CLI（import-userbehavior/generate-synthetic-behavior/generate-synthetic-master/aggregate-daily）；`docs/commerce-data-ingestion.md`（自有数据连接器契约）。
- **逻辑**：5 列 CSV 契约；provider 书签（ingestion_jobs/sync_state）；seed=20251203 确定性抽样。
- **验收**：事件 1,013,367/10,000 用户/2017-11-25~12-03；items 412,130；CLI 可复现。

### P3 零售 Domain Pack
- **结构**：`src/lib/domains/retail/**` 16 文件；删 `domains/finance`；`src/lib/commerce` 21+7 文件零售化；删 StrategyScan*/33 金融 e2e。
- **逻辑**：默认 Profile=`shopgate.retail-ops`；`finance.quant`→`retail.core`。

### P4 前端切片
- **结构**：`PlatformSwitcher` 三入口（/ /commerce-platform /operations-briefing）；ToolResultItem 零售化。

### P5 最小闭环
- **结构**：act-preparation→data-prefetch→generation-executor→validation→visual-validation。
- **逻辑**：Query Rewrite(LLM)→Run Plan→预取（窗口动态取自 dataset_meta）→确定性标准看板→验证链→receipt→预览。
- **验收**：零售问题→ready/validation=passed/预览 200；window 2017-11-25~12-03。

### P6 商品池/品类池/渠道 + 富看板
- **结构**：`retail-scaffold-templates.ts`（四能力多面板模板）+ `retail-scaffold-dashboard.ts`（分发）+ `config/evals/task-e2e-retail-v1.json` 前身逻辑。
- **模块**：`/commerce-platform` 三视图页；`GET /items`、`GET /channels` 端点；`check-retail-e2e-benchmark`（P9 加）。
- **逻辑**：capability 分发模板；SVG `dangerouslySetInnerHTML`；视觉校验放宽 `retail-workbench` 金融语义。
- **验收**：`--limit=1/4` R01–R04；`/items` total=412,130。

### P7 经营情报中心 + 日报链路
- **结构**：`retail-briefing.ts`（数据层）+ `/operations-briefing` 三视图 + `retail-daily-report.ts` + `/api/commerce/briefing/daily`。
- **逻辑**：日报=窗口末日快照（/summary+类目榜）→ OperationBrief 持久化 → GET 读回。
- **验收**：POST→runId/reportId；`operation_briefs` 落库「经营日报 2017-12-03」。

### P8 Skills 零售化
- **结构**：12 核心 skill；`quant-*`→`commerce-*` 六个领域 skill major 改名；新增 `commerce` scope 命名策略。
- **模块**：scenario_templates.md 补 4 零售场景段（修 scenario-template 资源）；finance-*→retail-* 路径；品牌词/quant_ 工具名归零。
- **发布流**：改源→registry/changelog→`package:skills -- <id>`→不可变版本快照→`check:skills`。
- **验收**：check:skills 绿；grep 品牌词/quant_/finance-* = 0。

### P9 评测与基准
- **结构**：`config/evals/task-e2e-retail-v1.json`（30 零售 case）+ campaign `--dataset` + `check-retail-e2e-benchmark.js` + 6 金融 eval 入口/runner 改为零售校验委托。
- **逻辑**：金融 eval 数据体系无零售输入不可重建→归档；零售真实校验=确定性契约对错判定。
- **验收**：`--dataset=task-e2e-retail-v1 --limit=1/4` → R01 READY、R02–R04 READY；`check:retail-e2e` 绿；6 入口 exit 0。

### P10 docs/README 终审
- **内容**：src 运行时文案 量化/投研/股票 67→0（权限 key 保留）；`.pi` changelog 品牌词 30→0；4 篇金融文档归档横幅；module-boundaries 补登 retail-domain；视觉检查断言旧文案修正。
- **验收**：`check:docs` 54 文件 282 链接绿；src 金融措辞 0；品牌残留仅出处/历史记录。

### P11 平台文件迁移
- **结构**：18 纯平台模块 + 8 测试 → `src/lib/generation/**`；commerce 仅零售域。
- **验收**：type-check/check:skills/check:retail-e2e/module-boundaries/vitest 全绿（仅基线 28）。

### 本轮 UI 变更（追加交付）
- **主题青白化**：`globals.css` `--primary/--ring/--accent` hue 10(红)→190(青)，浅/深两套；语义 destructive/amber 保留。
- **去图**：登录页主视觉插画→青色渐变纯色背景；主页右上装饰插画→primary 光斑；删 `next/image` import。
- **登录提示修正**：误导性「本地默认：admin / admin」→ 真实凭证提示。
- **实测**：渲染页 `--primary=190 85% 38%`，主按钮 `rgb(15,152,179)`（青）。

---

## 2. 交接核查清单（接手人按此逐项跑）

```bash
# 门（全绿）
npm run type-check
npm run check:skills
npm run check:retail-e2e          # 需 tmp/ 内有零售基准运行证据
npm run check:docs
npx vitest run src/lib src/app    # 仅既有基线 28 失败
node scripts/checks/check-module-boundaries.js
cd services/commerce-data && .venv/bin/ruff check src && .venv/bin/python -m pytest -q
```

**功能抽验**
- [ ] 登录：`admin@shopgate.local` / `shopgate2025` → 进 /（青白主题，无插画）。
- [ ] `/commerce-platform`：商品池 20 行/total 412,130；品类池 100；渠道 3 tier。
- [ ] `/operations-briefing`：daily 摘要+环比；categories=100；watch=20；点"生成今日日报"→ `operation_briefs` 新增行。
- [ ] 基准：`npm run check-task-e2e -- --dataset=task-e2e-retail-v1 --limit=1 --campaign=<新id>` → READY。
- [ ] 数据：`SELECT source,COUNT(*),MIN(event_ts),MAX(event_ts) FROM commerce.user_behavior_events GROUP BY source` → tianchi_userbehavior/1,013,367/2017-11-25~12-03。

---

## 3. 遗留问题（按优先级，均已记录 ISSUES）

| # | 遗留 | 现象/原因 | 建议 |
| --- | --- | --- | --- |
| 1 | `check-skills-visual`/`check-platform-visuals` 失败 | 登录态/`main:visible` 定位器/页面状态；断言已改 Skills Market 仍超时 | 单独排查（运行态诊断），非本次引入 |
| 2 | catalog case 偶发"输出 token 预算达成" | R01 变量性失败 | 调 agent 输出预算或失败重试 |
| 3 | `retail-validation.ts` 3140 行预算警告 | 大文件 | 按 artifact/data-contract/visual/repair/acceptance 拆分 |
| 4 | 改名 skill body/scripts 金融计算逻辑 | 功能正确性 | 按零售语义重写（rule-review/metrics 优先） |
| 5 | 判官校准/变异/生产回放无零售语料 | 评测深度 | 语料积累后按 A 路线重建（机制层已保留） |
| 6 | 日报推送回执需通知渠道 | 触达 | 配置企业微信/邮件渠道后接通 |
| 7 | `retail-domain.publicSurface` 仍指 `@/lib/domains/finance` | 配置正确性 | 改为 `@/lib/domains/retail` |
| 8 | `assets/` 文件名带 quant（4 个 webp） | 品牌残留（文件名） | 改名 + 更新 2 处 import |
| 9 | `docs/commerce-data-source-knowledge.md` 等归档文档 | 文档噪音 | 后续删除或深化零售化 |

## 4. 迭代进化路线

**近期（巩固）**
1. 遗留 #1/#2：恢复 UI 视觉回归 + 降低基准 flaky。
2. `retail-validation.ts` 拆分（按管线段）。
3. skill 脚本功能零售化（#4，rule-review/metrics 优先）。

**中期（能力补齐）**
4. 观察池产品化（`BriefWatchPool` 可管理：增删/阈值/订阅）。
5. 日报触达（遗留 #6）。
6. **零售判官 v1**：规则化 rubric（必备组件/图表/标注/口径加权打分）——不需要黄金集。
7. 第二零售数据源接入（验证连接器可插拔性）。

**长期（体系升级）**
8. 判官校准/生产回放重建（待零售语料/流量）。
9. 多模型 passRate 对比评测。
10. 权限体系 `quant.*`→`commerce.*`（涉及 DB/配额迁移，需独立迁移方案）。

**迭代节奏**：每迭代 = 1 能力增强 + 1 技术债清偿 + 全部门 + 零售基准回归（`--limit=4`）。新增能力必须带确定性契约校验入门；主观质量分层（rubric/判官）为后续增强，不阻塞门。
