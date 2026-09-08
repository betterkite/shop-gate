# Shop Gate Issue 清单

> 轻量纪律（源自 RepoSteward 工作流）：每个改动包一个分支 → 测试门通过 → 合入 `main`。
> 状态：`open` / `in-progress` / `done` / `deferred`。阶段定义见 PROVENANCE.md 与共识阶段计划。

| ID | 标题 | 阶段 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| ISSUE-P0 | 落地与地基：导入快照、构建修复、机械换牌、删 benchmarks | P0 | 6 个提交全部过测试门；品牌串 grep 归零（例外清单见 PROVENANCE.md 与下方台账）；基线已知失败记录在案 | done |
| ISSUE-P1 | 零售电商 PRD：定位、非目标、4 capabilities、数据口径（真实/合成边界）、页面映射表、验收标准 | P1 | `docs/prd.md` 完成并经用户签字确认 | done（v0.2 签字：用户指示继续，A–E 全部采用 PRD 提案——A=1万用户抽样、B=§6.1 三条 prompt、C=§6.2 十项指标、D=路由更名、E=移除 StrategyScan*；可随时推翻重开） |
| ISSUE-P2 | 数据切片：`commerce.*` 零售 schema、UserBehavior 抽样导入 provider、合成商品主数据、commerce-data 最小接口、prisma 追加式 migration | P2 | `db:up` → 导入成功 → 领域接口可 curl；SQL `quant.*` schema 处置完成 | done（合成为兜底；**真实 UserBehavior 数据已接入**：经公开镜像切片→过滤规范窗口→`import-userbehavior --time-shift none`，落库 1,013,367 事件 / 10,000 用户 / `source=tianchi_userbehavior`，窗口 2017-11-25~12-03；连接器接口见 `docs/commerce-data-ingestion.md`） |
| ISSUE-P3 | retail Domain Pack：按 docs 七步建 `src/lib/domains/retail/`（4 capabilities），注册 + 切默认 Profile；重写 `src/lib/commerce` 21+7 领域耦合文件（含 `pi-agent-prompts.ts` 高危点）；移除 `finance.quant` 包；module-boundaries 登记 | P3 | 测试/typecheck/边界检查绿；可创建零售任务 | done（finance 包已删除；默认 Profile=shopgate.retail-ops；type-check/vitest=基线水平 29F 已归因/pytest 109P/边界+skills+docs 绿；残留台账见下方 P3 完成小节） |
| ISSUE-P4 | 前端切片：首页零售示例 prompt、导航与通用文案、ToolResultItem 领域渲染、商品池最小可用页、经营情报中心占位 | P4 | `npm run dev` 可用；首页/商品池无金融文案残留 | done（导航=经营工作台/商品运营/经营情报；ToolResultItem 零售化；路由 research-reports→operations-briefing；首页 prompt=PRD §6.1；商品池最小页随 P6 全量交付；视觉验证归 P5 e2e） |
| ISSUE-P5 | 最小闭环验收：自然语言零售问题 → 生成 dashboard 端到端 | P5 | 用户验收通过 | **待用户最终验收（真实数据口径）**——已在真实数据上重跑并 **ready / validation=passed**：`data/projects/project-retail-p5-r14559`，预览 **http://localhost:4129**（HTTP 200）；`behavior_source=tianchi_userbehavior`（10,000 用户 / 1,013,367 事件），窗口 2017-11-25~12-03（`--time-shift none`）；金额/库存为合成主数据（GMV=buy×合成价），页脚明示。修了一处脚手架 bug（`fix/p5-scaffold-null-meta`：`meta.behavior_source` 缺 optional chaining 导致 next_build 类型检查失败），此前重跑曾卡在 repair/scenario-template；现全绿。 |
| ISSUE-P6 | 商品池/品类池/渠道分析全量重建（原 strategy-platform 6,299 LOC） | P6 | 1:1 映射完成，视觉 smoke 通过 | done（实现，**待用户最终验收**）：P6a–P6f 全链交付——**四种能力看板都多面板化**（catalog 柱/环/趋势、funnel 柱/阶段环/趋势、price 价格带/库销比/健康环、daily 摘要卡+环比+类目 GMV 柱状），真实数据 e2e 全部 `ready` + visual passed（catalog svgCount3、funnel 3、price 2、daily 1）；**`/commerce-platform` 商品运营页**（商品池/品类池/渠道三视图）登录态真实数据渲染；**数据端点** `/items`（分页/类目/排序）与 `/channels`（店铺 tier 渠道）；**合成口径+来源标注**齐全。修了一处跨域视觉校验 bug（visual-validation.ts 若存在 `retail-workbench` 标记则放宽金融语义词强制，否则 funnel/daily 会被 repair 恢复 base）。门：type-check/vitest 246/pytest 109/ruff/边界全绿。注：`:8000` 需重启加载新端点（已重启验证；生产部署时注意）。提交 `e854ffc`/`421615f`/`684a435`/`b20784e`/`3ec6537`/`9b22477` 已合入 main）。 |
| ISSUE-P7 | 经营情报中心全量（原 research-reports 891 LOC + 日报自动化） | P7 | 日报链路可运行 | done（实现，**验收=日报链路可运行已达成**）：P7a `e1ad56c` 零售**经营情报中心**（`retail-briefing.ts` 数据层 + `/operations-briefing` 三视图替换金融"投研情报中心"，daily/categories=100/watch=20 真实数据+合成标注）；P7b `34006d1` **日报链路可运行**（`retail-daily-report.ts` 生成并持久化 OperationBrief/OperationBriefRun + `/api/commerce/briefing/daily` GET/POST + daily 视图"生成今日日报"按钮与最近生成日报）。验证：POST→runId/reportId、GET 读回、DB 落库（operation_briefs 经营日报 2017-12-03，run status=completed）。注：**推送回执**依赖通知渠道配置（零售无 watchlist/channel，暂未接，留作后续）。门：type-check/vitest 232/pytest 109/边界（无新增失败） |
| ISSUE-P8 | Skills 重写与清洗：6 个领域 skill 零售化 + 5 个通用 skill 清洗金融示例 + registry/lock/tgz/capsules 同步（注意：skill 是带版本的发布物，需走版本 bump + 发布快照流程） | P8 | `npm run check:skills` 绿；`.pi` 内品牌词归零 | in-progress（P8a 已并 main `9f3e10d`：**修复 dashboard-visualization 缺 `scenario-template` 资源**——scenario_templates.md 只有金融模板段，零售模板 id(catalog-structure 等) 无段 → retail repair 路径死；已补 4 个零售场景段并**走完整发布流**（minor 0.6.1→0.7.0：registry/changelog/lock/package/不可变快照 0.7.0.tgz），`check:skills` 绿。验证了 skill 发布协议。P8b 已并 `56309af`：**finance-*→retail-* 路径清洗**（run-planner/query-rewrite/quant-symbol-resolver/data-quality/dashboard-visualization 的 SKILL.md、reference、validate_query_rewrite.py、registry 中 finance-run-plan/finance-query-rewrite→retail-*），逐个 minor 发布（0.5.0/0.6.0/0.4.0/0.5.0/0.8.0 + 快照），`.pi` 内 finance-* 路径 token 归零，`check:skills` 绿。P8c 已并 `e5c91cb`：**品牌词归零**——`.pi/skills`+registry+capsules 中 QuantPilot/quantpilot/QUANTPILOT_ → Shop Gate/shopgate/SHOPGATE_（12 skill patch 发布 + 快照），grep 归零。P8d 已并 `bde55ad`：**quant_extract_uploaded_image→commerce_extract_uploaded_image**（对齐 runtime `commerce_*` 契约，image-extraction 0.4.3）。至此 `.pi` 内**品牌词、quant_* 工具名、finance-* 路径均已归零**，`check:skills` 绿。P8e 已并 `de4b6e5`：**6 个领域 skill 零售化改名**（major、原子）——quant-market-data→commerce-market-data、quant-fundamentals→commerce-master-data、quant-backtest→commerce-rule-review、quant-indicators→commerce-metrics、quant-data-registry→commerce-data-registry、quant-symbol-resolver→commerce-entity-resolver；SKILL.md frontmatter 名称/描述/标题零售化；**新增 `commerce` scope** 到 skill 命名策略（check-skills-registry.js）并改 scope=commerce；全域 103 文件原子更新（skills-registry.ts/retail-act-preparation.ts/cli/pi-agent.ts/chat-message-runtime.ts/SkillsManagementClient/测试 + config/capsules + registry/changelog/lock + docs）；重发布（6 skill 1.0.0→1.0.1 + 交叉引用 run-planner 0.6.0/image-extraction 0.5.0/dashboard-visualization 0.9.0），清除孤立 quant-* 包/快照。**至此 P8 全部达成**：check:skills 绿、`.pi` 品牌词/quant_* 工具名/finance-* 路径/quant-* skill id 全归零、6 领域 skill 已零售化。注：改名 skill 的 body/scripts 仍含金融计算逻辑（功能级零售化归 P9）。 |
| ISSUE-P9 | 评测与 e2e 基准重建（eval 7 文件渗漏 + benchmarks 替代方案）；benchmarks 数据已于 P0 删除，相关检查入口当前为显式 SKIPPED | P9 | 新基准可运行，SKIPPED 守卫移除，恢复真实校验 | in-progress（P9a 已并 main `be98355`：**零售 task-E2E 基准基础设施**——新增 `config/evals/task-e2e-retail-v1.json`（30 条零售 case，覆盖 catalog/traffic_funnel/price_inventory/daily_brief，deepseek 模型）；`check-task-e2e-campaign.ts` 支持 `--dataset=<name>` 切换（默认仍是金融 `task-e2e-v1`）。已用 `--dataset=task-e2e-retail-v1 --limit=1` 跑通：创建 `project-e2e-retail-e2e-1-r01` 并 act/轮询/报告；该 case 命中 `needs_clarification`（本轮运行上下文报 query-rewrite LLM 未配置——运行/配置环境项，非基准结构问题）。余：让 case 直达 ready（解决 run 上下文 query-rewrite LLM 配置）、**SKIPPED 守卫移除**（check-eval-* 仍 gate 在被删的 finance `src/lib/domains/finance/`+`data-prefetch.ts`）、**P8 改名后 skill 脚本的功能级零售化**） |
| ISSUE-P10 | docs/README 内容级重写 + 品牌终审（grep 终验） | P10 | 文档与实际一致；品牌归零复查通过 | open |
| ISSUE-P11 | （可选）`src/lib/commerce` 33 个纯平台文件物理迁移 `src/lib/generation/` | 后续 | 迁移后全部门绿 | deferred |

## P0 结果与残留台账（2025-09-06，随阶段推进收敛）

**门结果**（对比提交 1 基线）：

| 门 | 基线 | P0 完成 |
| --- | --- | --- |
| type-check | ✅ | ✅ |
| vitest | 28F / 1160P / 24S（4 文件，环境依赖） | 29F / 1155P / 28S（基线 4 文件 + 1 个已归因，见下） |
| 后端 ruff + pytest | ✅ 112 passed | ✅ 112 passed |
| check:skills / check:docs | 上游绿 | ✅ 12 skills / 51 docs / 272 links |
| check-backend-architecture / check-service-catalog | 上游绿 | ✅ |

**基线已知失败（环境依赖，非本项目引入）**：`pi-agent-terminal.test.ts` 25、`skills/compiler.test.ts` 1（源目录哈希/路径校验）、`preview.test.ts` 1、`generated-project-sandbox.test.ts` 1。

**换牌新增 1 个已归因失败**：`skills/compiler.test.ts` 工具名断言——TS 合同已改 `commerce_*`，`.pi` 源按 P8 决策保留上游 `quant_*`，跨阶段缝隙，P8 收敛。

**残留台账**：

| 残留 | 规模 | 归属 |
| --- | --- | --- |
| `.pi` skill 源内品牌词（QuantPilot/quantpilot/QUANTPILOT_） | 33 文件 | P8 |
| `Quant*` 平台标识符（QuantGenerationStep 等，注意 `Quantity` 不动） | ~1,684 处 | P3/P8 |
| `sqls/` 中 `quant.*` schema 引用 | 544 处 | P2 |
| `finance.quant` 领域包 | 4.4k LOC | P3 删除 |
| skill id `quant-*` 家族（目录/registry/lock/tgz） | 6 个 skill | P8 |
| benchmarks 数据 | 已删除，6 检查入口显式 SKIPPED | P9 |

**环境注意**：目录改名后 `services/commerce-data/.venv` 的 console 脚本 shebang 失效（绝对旧路径），`rm -rf .venv && uv sync` 重建即可（P0 已处理一次）。

## P3 完成小结（2025-09-06）

**领域包（新增）**：`src/lib/domains/retail/` 16 个文件（capabilities/agent-profile/intent/mission-definition/query-rewrite+llm/workspace/data-agent-projection/data-identity/entity-aliases/visualization-templates/agent-tools×6/barrel）+ 零售脚手架模板（4 能力页面 + base + 合成徽标）。

**运行时切换（删旧换新）**：`domains/finance` 整包删除；data-prefetch / generation-executor / capability-center / validation / act-preparation / prompts / cli / preview / mission-control / observability 全部零售化；StrategyScan* prisma 模型 + 33 个金融 e2e 用例 + strategy-platform 金融 UI 移除（商品池归 P4/P6）。

**残留台账**：
- `.pi` skill 品牌词（33 文件）与 quant-* skill 家族 → P8（不变）
- `Quant*` 平台标识符残留（generation-state/queue/observability 等平台文件内部）→ P8/P10（不变）
- `sqls/` commerce.* 已完成（P2）；`market_data_*` 表名保留（平台表名，非品牌）→ P2 已裁定保留
- benchmarks 数据已删除（P9 重建）；SKIPPED 守卫仍在

**P3 门**：type-check 全绿；vitest 29F/1003P/28S（基线 29F 已归因：pi-agent-terminal 25 环境 + compiler 1 归因 + preview 1 环境 + sandbox 1 环境）；pytest 109P；backend-architecture / service-catalog / check:skills / check:docs 全绿。
