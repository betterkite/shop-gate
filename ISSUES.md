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
| ISSUE-P6 | 商品池/品类池/渠道分析全量重建（原 strategy-platform 6,299 LOC） | P6 | 1:1 映射完成，视觉 smoke 通过 | in-progress（P6a 已并 main `e854ffc`：**标准生成按 capability 分发到能力看板模板**，4 项能力模板修复——`meta` 声明、`.filter(Boolean)`→类型守卫、`svgBars/svgDailyLines` 用 `dangerouslySetInnerHTML` 真正渲染 SVG。P6b 已并 `421615f`：catalog 看板升级为**多面板**（GMV 柱状图 + Top-5 集中度环形图 + 分日趋势线），真实数据 `ready`、visual `svgCount=3`/`graphicCount=14`。余：商品池/品类池/渠道分析业务页） |
| ISSUE-P7 | 经营情报中心全量（原 research-reports 891 LOC + 日报自动化） | P7 | 日报链路可运行 | open |
| ISSUE-P8 | Skills 重写与清洗：6 个领域 skill 零售化 + 5 个通用 skill 清洗金融示例 + registry/lock/tgz/capsules 同步（注意：skill 是带版本的发布物，需走版本 bump + 发布快照流程） | P8 | `npm run check:skills` 绿；`.pi` 内品牌词归零 | open |
| ISSUE-P9 | 评测与 e2e 基准重建（eval 7 文件渗漏 + benchmarks 替代方案）；benchmarks 数据已于 P0 删除，相关检查入口当前为显式 SKIPPED | P9 | 新基准可运行，SKIPPED 守卫移除，恢复真实校验 | open |
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
