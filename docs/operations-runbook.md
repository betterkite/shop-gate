# 运行手册

这份 runbook 面向本地开发和演示排障。它补充 [故障排查](troubleshooting.md)：故障排查负责“先看哪里”，runbook 负责“一个任务应该怎么安全执行、怎么停、怎么恢复”。

## 基础启动

日常开发推荐直接启动完整栈；该命令会复用已健康的 commerce-data，否则自动启动并在退出时一并回收：

```bash
npm run dev
```

需要手动分组件排障时，再按以下顺序启动：

```bash
npm run db:up
npm run db:init
npm run obs:up
cd services/commerce-data
uv sync
uv run shopgate-commerce-api
```

另开一个终端回到项目根目录，仅启动前端：

```bash
npm run dev:web
```

检查：

```bash
npm run doctor
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/api/v1/commerce/meta
```

如果只想看页面结构，可以用降级模式；涉及真实零售数据、导入任务和生成链路时不要长期保持 offline：

```bash
SHOPGATE_DEGRADATION_MODE=offline npm run dev
```

## ModelPort、Memory 与 AKEP 日常检查

三方服务启动后先运行只读验收：

```bash
npm run check:integrations
```

成功表示 Shop Gate 默认 Qwen profile、ModelPort Qwen 与 DeepSeek 的模型发现/鉴权/工具流和续写、Qwen LLM Query Rewrite、Memory 契约和 readiness 均正常。DeepSeek 上游使用 ModelPort 的 Anthropic provider。该命令会产生真实模型 Token，但不写 Memory；输出不会包含凭据或记忆正文。AKEP 的检索、Citation、Usage 和 Feedback 由下方 `check:triad-experience` 验收，不把 Model/Memory 的只读探针误写成四方全链路。

发布验收、契约升级或故障恢复后，执行 `npm run check:triad-experience`；跨平台 scope、模型或身份边界变更后再执行 `npm run check:triad-experience:large`。后者会使用四个固定合成 subject 执行真实 Memory 写入和反馈闭环，不要放进每分钟健康检查。

生产 Memory 发布必须额外执行 `npm run check:memory-production`。它要求 Memory 返回
`production_ready=true`、`jwt/access_token` 身份边界、Shop Gate 使用短期 token broker，并以配置的
非人类 probe subject 实际读取偏好列表，从而同时验证 JWT、JWKS、tenant/subject grant、
ProcessingGrant、PostgreSQL 治理和耐久审计；只访问 `/health` 不算通过。

需要验证真实问答体验，而不只是端点存活时，运行固定 30 题验收集：

```bash
npm run check:triad-experience
```

它覆盖 12 题大模型 Query Rewrite、6 题 Memory 写入/隔离/退出/归因、6 题 AKEP 检索/Citation/Usage/Feedback，以及 6 题模型与两类上下文的组合回答（其中一题验证 ModelPort DeepSeek）。报告写入 `tmp/triad-experience-latest.json`；测试只使用固定合成 subject 和隔离知识 Space，不读取真实用户记忆，也不输出凭据。可用 `-- --only=Q01,M02,K03,T04` 定点复测。

上述体验集直接调用版本化服务边界，不创建任务记录。需要验收首页真实任务、Workspace、Mission 和最终预览时，先用两题校准，再用同一批次续跑全部 30 题：

```bash
npm run check:task-e2e -- --campaign=20260719a --limit=2
npm run check:task-e2e -- --campaign=20260719a
```

该命令会真实登录、调用 Project 与 `/act` API，并在任务抽屉保留 `[E2E 20260719A/Cxx]` 记录；不要把它用于分钟级探活。重复使用同一 campaign 会恢复已有任务，不会复制创建。默认并发 2、单任务最长 20 分钟，可用 `--concurrency=1..4`、`--timeout-ms=...` 和 `--only=C01,C06` 控制。成功必须同时满足当前 Validation 通过、Mission accepted receipt 存在、核心产物完整、持久预览返回 HTTP 200，以及全部测试任务能在抽屉搜索到。状态轮询的 GET 请求会对短暂断连和 408/425/429/502/503/504 做有界重试；POST 不会被脚本盲目重放。

如果少数 case 已进入权威失败终态，使用相同 campaign 和显式重试序号原地复测：

```bash
npm run check:task-e2e -- --campaign=20260719a --only=C18,C26,C27 --retry-failed=2
```

`--retry-failed=N` 只重试失败 case，并继续使用原 Project/任务抽屉记录；新的 request ID 使用 `-rN` 后缀。处于 `pending/running/repairing` 的任务不会被当成失败重放，脚本会继续等待自动修复和 Mission 验收。重试结束后再执行一次不带 `--only` 的完整命令，把 `tmp/task-e2e-<campaign>-latest.json` 恢复为全部 30 题的最终报告。该 `latest` 文件会被同 campaign 的每次执行覆盖，定点复测报告不能冒充全量报告。完整 30 题全部通过时，脚本默认在抽屉验收后清理测试 Project/Workspace；人工看板复核使用 `--retain-projects`，清理失败或部分批次使用 `--cleanup`。

推荐排障顺序：

1. ModelPort `/livez`、`/readyz` 和带鉴权的 `/v1/models`。
2. ModelPort 管理台中 `deepseek` provider 的“查询余额”；它只读调用 DeepSeek 官方余额接口，充值和账单仍由 DeepSeek 控制台处理。
3. Memory 根 discovery 和 `/readyz`；同时检查 `production_ready`，不要只看 HTTP 200。
4. AKEP `/health`、ContextPack 与 Shop Gate 配置的 Space；空 Space 即使 HTTP 200 也不会改善回答。
5. `npm run check:integrations`，区分模型发现、工具协议、Query Rewrite 和 Memory 契约错误。
6. `npm run check:triad-experience`，检查语义和组合体验，不以单次聊天主观判断兼容性。
7. `curl http://127.0.0.1:3000/api/ready` 与 `npm run doctor`，确认 Shop Gate 自身数据库和本地归因表。

如果数据预取已成功但没有生成看板，先检查项目 `.data-agent/retail-run-plan.json`：`queryRewrite.outputIntent` 应为 `dashboard`、`visualization.required` 应为 `true`，再核对 `templateId/variantId` 是否有受信 renderer。`queryRewrite.execution.llm.guardedFields` 出现 `outputIntent` 表示模型尝试无证据降级，平台已恢复默认看板；项目重新初始化不应出现“承接上一轮澄清”等前缀。

四个仓库必须独立升级和回滚。Shop Gate 不能导入 ModelPort、Memory 或 AKEP 内部源码，外部服务不能共享 Shop Gate 数据库；跨仓兼容只以 `OpenAI-compatible HTTP`、`evolvable-memory-http/v1` 和 `AKEP v0.1 HTTP` 契约为准。

## 本地后台重启

开发机上需要重新启动前后端时，只处理主前端和 commerce-data，不要顺手重建数据库卷。推荐流程：

```bash
web_pgid="$(ps -eo pgid=,cmd= | awk '/npm run dev --port 3000/ {print $1; exit}')"
api_pgid="$(ps -eo pgid=,cmd= | awk '/uv run shopgate-commerce-api/ {print $1; exit}')"
[ -n "$web_pgid" ] && kill -TERM -- "-$web_pgid"
[ -n "$api_pgid" ] && kill -TERM -- "-$api_pgid"
sleep 2
```

然后后台启动并写入本地运行日志：

```bash
mkdir -p tmp/runtime
setsid bash -c 'cd services/commerce-data && exec env SHOPGATE_MARKET_HOST=127.0.0.1 SHOPGATE_MARKET_PORT=8000 uv run shopgate-commerce-api' > tmp/runtime/market-api.log 2>&1 < /dev/null &
setsid bash -c 'exec npm run dev -- --port 3000' > tmp/runtime/web.log 2>&1 < /dev/null &
```

确认：

```bash
curl http://127.0.0.1:8000/health
curl -I http://127.0.0.1:3000
tail -n 80 tmp/runtime/web.log
tail -n 80 tmp/runtime/market-api.log
```

前端日志里应该看到 `Starting Next.js dev server on http://localhost:3000`。当前项目不再接入 `next-rspack`；如果日志里出现 Rspack 相关提示，说明依赖或启动命令不是当前模式。

## 长任务通用规则

| 规则 | 说明 |
| --- | --- |
| 先查本地覆盖 | 本地已有完整数据时不重复导入外部切片 |
| 分批执行 | 大商品池导入和日聚合分批执行，不一次性打满 |
| 可暂停可继续 | 暂停保存 offset、批次和统计 |
| 停止不删事实 | 停止只终止任务，不删除已落库行为事件和日聚合 |
| 记录任务日志 | 任务状态、错误、入库行数和最近心跳必须可查 |
| 限制并发 | 外部数据导入要低并发、带 delay 和失败重试 |

## 零售数据导入与刷新

用途：导入或重建零售事实库：天池淘宝 UserBehavior 行为切片（原始窗口 2017-11-25 ~ 2017-12-03）、合成主数据（价格/库存/品牌/店铺，合成口径）和商品/类目日聚合。

入口是 `shopgate-commerce-import`（`services/commerce-data` 的 console 脚本）：

```bash
cd services/commerce-data
uv run shopgate-commerce-import import-userbehavior --csv <path> --users 10000 --seed 20251203 --time-shift none
uv run shopgate-commerce-import generate-synthetic-behavior
uv run shopgate-commerce-import generate-synthetic-master
uv run shopgate-commerce-import aggregate-daily
```

事件 CSV 契约：表头严格 5 列 `user_id,item_id,category_id,behavior_type,timestamp`（Unix 秒）。行为类型为 `pv`(曝光) / `fav`(收藏) / `cart`(加购) / `buy`(购买)。零售数据是固定窗口的公开切片，没有“每日收盘后入库”的需求；重新演示其他窗口时使用 `--time-shift last-week`。

导入命令以进程退出码作为成功信号；可重复执行的重建语义由 CLI 自身保证。任务表只保留导入记录和数据源书签，不再提供旧行情域的 HTTP 控制面。

### 验证导入结果

先用 `/meta` 核对数据窗口和用户规模：

```bash
curl http://127.0.0.1:8000/api/v1/commerce/meta
```

期望：`first_event_ts=2017-11-25T00:00:00Z`、`last_event_ts=2017-12-03T16:00:06Z`、`user_count=10000`、`behavior_source=tianchi_userbehavior`。

再抽查落库行数：

```bash
npm run db:psql
```

```sql
SELECT count(*) AS events FROM commerce.user_behavior_events;    -- 期望 1013367
SELECT count(*) AS item_days FROM commerce.daily_item_metrics;   -- 期望 687562
SELECT count(*) AS category_days FROM commerce.daily_category_metrics; -- 期望 30644
SELECT count(*) AS items FROM commerce.items;                    -- 期望 412130
```

如果行数明显偏少，先看导入 CLI 的终端输出和 commerce-data 日志，再检查 `commerce.market_data_ingestion_jobs` 的最近记录。

## 商品池与观察池维护

- 商品/类目/品牌/店铺主数据为合成口径，由 `generate-synthetic-master` 生成；调整规模时用导入 CLI 重新生成，不要手改单行。
- 观察池目前是 `/operations-briefing` 页面的经营情报能力（经营日报/类目经营榜/观察池）；独立池管理接口待补充。
- 渠道分层为 standard/premium/flagship 三档，聚合数据通过 `GET /api/v1/commerce/channels` 读取。

检查主数据规模：

```sql
SELECT 'items' AS entity, count(*) FROM commerce.items
UNION ALL SELECT 'categories', count(*) FROM commerce.categories
UNION ALL SELECT 'brands', count(*) FROM commerce.brands
UNION ALL SELECT 'shops', count(*) FROM commerce.shops;
```

期望：items 412,130、categories 5,922、brands 200、shops 500。

如果页面商品池加载慢，优先确认服务端分页（`GET /api/v1/commerce/items` 的 `page`/`page_size`，`page_size` ≤ 100）和 Redis 缓存可用，不要把前端改回全量加载。

## 生成工作空间验证失败

排查顺序：

```text
.data-agent/retail-run-plan.json
.data-agent/generation-state.json
.data-agent/events.jsonl
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
.data-agent/validation.json
.data-agent/artifact-contracts.json
.data-agent/visual-validation.json
.data-agent/validation-repair-plan.json
```

常见处理：

| 失败 | 处理 |
| --- | --- |
| build 失败 | 修当前工作空间代码，不改平台源码 |
| final data 存在但页面没消费 | 修页面数据绑定和模板选择 |
| 多商品被单商品模板展示 | 更新 `dashboard-visualization` 或模板匹配规则 |
| 页面只有验证失败页 | 先看 validation，再触发自动修复 |
| 出现 mock/static 样例 | 清理页面假数据，引用真实 final data |

## Skills 更新和发布

修改 skills 后必须跑：

```bash
npm run check:skills
npm run package:skills
```

如果改动影响生成页面，再补跑：

```bash
npm run check:validation-repair
npm run check:project-visual
npm run check:platform-visuals
npm run check:retail-e2e
```

涉及零售端到端任务链路时，用零售基准数据集跑指定 campaign：

```bash
npm run check:task-e2e -- --dataset=task-e2e-retail-v1 --campaign=<id> --limit=1
```

失败案例应优先沉淀成规则，而不是只修某个生成工作空间。

## 提交前质量门

日常改动先运行确定性质量门。它不依赖已启动的数据库、数据服务或 Loki，会统一检查文档链接、模块边界、契约、前后端 lint/测试、类型和生产构建：

```bash
npm run release:check
```

正式发布再运行完整质量门。它额外使用 npm 官方 registry 审计全部直接/传递依赖，并执行运行态 `doctor:full`；因此数据库、数据服务和 strict 模式要求的组件必须可用：

```bash
npm run release:check:full
```

生产发布还必须使用生产环境执行配置预检、standalone 构建和真实启动 smoke：

```bash
npm run release:check:production
```

完整的备份、迁移、readiness、切流、回滚和恢复顺序见[生产发布 Runbook](release-runbook.md)。

检查全部依赖安全状态可运行 `npm run security:audit`，只看生产依赖可运行 `npm run security:audit:production`；只检查 Markdown 本地链接可运行 `npm run check:docs`。

涉及数据库：

```bash
npm run db:init
npm run db:doctor
```

涉及生成链路：

```bash
npm run check:validation-repair
npm run check:generated-artifacts
npm run check:benchmark-coverage
```

## 什么时候引入新组件

| 组件 | 触发条件 |
| --- | --- |
| 对象存储 | 截图、规则验证报告、原始 CSV 切片和大 JSON 明显膨胀 |
| 独立 Worker | 导入、日聚合、批量指标任务需要脱离 Next.js/uvicorn 进程 |
| 列式分析引擎 | 超大行为事件扫描或跨窗口聚合进入主线时再单独评估 |
| 消息队列 | 任务需要跨机器分发和可靠重试 |

短期优先把 PostgreSQL/TimescaleDB + Redis + Loki 这套用扎实。
