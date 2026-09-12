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
| ISSUE-P8 | Skills 清洗与功能级电商化 | P8 | 12 个核心 Skill 的命名、registry、lock、tgz、capsule 一致；6 个领域 Skill 的脚本按电商指标工作 | in-progress（命名与发布合同已完成；`commerce-rule-review`、`commerce-metrics` 等 body/scripts 仍有金融计算逻辑，拆分为 ISSUE-P29 继续处理） |
| ISSUE-P9 | 零售评测与 E2E 基准重建 | P9 | 30 条零售 case、4 个能力、真实运行证据、评测报告和零售语料门禁完整 | in-progress（零售 task-E2E 基础设施和真实校验已完成；金融 judge/mutation/replay 语料仍需改为电商语料，纳入 ISSUE-P29/P30） |
| ISSUE-P10 | docs/README 内容级重写 + 品牌终审（grep 终验） | P10 | 文档与实际一致；品牌归零复查通过 | done（实现）：①**运行时文案归零**——src 内 量化/投研/股票 67 处→0（应用标题/manifest/登录/对话/权限显示标签/运维/业务知识/research-reports/scaffold），`quant.*` 权限 **key** 保留（系统标识符）；②**品牌终审**——`.pi/skills.changelog.json` 30 处 QuantPilot→Shop Gate，**6 个入口 + runner 的 eval 渗漏处理**（改为零售校验委托），视觉检查断言旧文案 QUANTPILOT SKILLS MARKET→Skills Market；品牌残留仅存在于**出处/历史记录**（PROVENANCE.md、docs/prd.md 来源说明、docs/review 历史、归档横幅），与 P0 例外清单同性质；③**4 篇金融文档归档标注**（行情采集/策略平台/投研日报 加金融域遗留横幅并指向零售替代；运行治理 保留但标注 quant.* 为金融遗留）；④**module-boundaries.md 补登 retail-domain**（替换过时 finance-domain 行）+ quant-core 描述零售化。门：type-check/check:skills/check:retail-e2e/check:docs（54 文件 282 链接）绿；vitest 仅既有基线。提交 `1e51e6d`/`00c0a3b`/`3d1d6c7`/`33170e0` 已合入 main。**遗留**：check-skills-visual/platform-visuals 视觉检查需单独排查（依赖 app 运行态与登录，非本次引入）；改名 skill 的 body/scripts 功能级零售化归 P9 后续；module-boundaries 的 4 个 missing-file 引用与 P11 迁移 |
| ISSUE-P11 | （可选）`src/lib/commerce` 33 个纯平台文件物理迁移 `src/lib/generation/` | 后续 | 迁移后全部门绿 | done（`eed58a1` 已并 main `00cd153`）：**18 个纯平台模块 + 8 个伴随测试**迁移至 `src/lib/generation/`（artifact-contracts/chat-act-contract/chat-act-support/evidence/generation-observability/preview/queue/runtime/state/terminal/validation/realtime-generation-status/repair-convergence/workspace-health/progress/response/data-agent-application/notification-adapters），33 文件 import 同步更新（含 workers 相对路径、research-reports 的 notification-adapters、idempotency test 的 vi.mock 路径）；config/module-boundaries.json：quant-core paths += `src/lib/generation/**`，并**修复 4 个过时 largeFileBudget 引用**（validation.ts→retail-validation.ts、data-prefetch.ts→retail-data-prefetch.ts、移除 StrategyPlatformClient.tsx/strategies.ts 行）——**module-boundaries 的 4 个 missing-file 失败就此清零**；docs/module-boundaries.md 登记 generation 模块行。门：type-check/check:skills/check:retail-e2e/check:docs/module-boundaries/vitest 全绿（vitest 仅既有基线 28） |
| ISSUE-P12 | 交接复核与 QuantPilot 残留清理（本轮） | P12 | 交接证据可复现；当前路由、文档、脚本、产物路径、权限/配额命名与未引用旧 UI/资产完成核查 | done（本轮专用分支）：删除无引用的旧 research API/UI、旧视觉检查脚本、QuantPilot 资产与归档噪音；修复文档断链、module boundary、视觉检查路由、验证 smoke 与默认零售 profile；新增交接记录。 |
| ISSUE-P13 | commerce-data 后端旧金融模块物理清理 | P13 | 运行入口只保留零售数据路由；旧行情/回测/ClickHouse/provider/models/tests/config/docker 残留有引用图、迁移说明和后端全门验证 | done（专用分支完成；运行入口/路由/依赖/Compose/环境/维护脚本已收敛，引用图与验证见 `docs/review/p13-backend-cleanup.md`） |
| ISSUE-P14 | generation/eval/scaffold 内部历史命名与模板语义零售化 | P14 | `Quant*` 平台类型、旧 finance 示例、旧脚手架模板和旧评测夹具按模块完成改名/清理；retail benchmark、type-check、vitest 回归通过 | done（generation-validation、mission control、chat、skills registry、API 测试和 guard 命名已零售化；删除未引用金融脚手架/旧 eval 测试夹具；视觉验证和模板门禁全部改为电商经营语义。技能 body/scripts 的功能级金融逻辑继续由 ISSUE-P8/P9 处理） |
| ISSUE-P15 | 权限与配额命名从 QuantPilot 迁移到 commerce/operations | P12 | 当前代码使用 `commerce.*` / `operations.*`；新增追加式 migration 同步 grant、override、quota、bucket、reservation、event；历史 migration 不改 | done（本轮已完成代码、文档、测试和 `20260909000200_rename_retail_access_metrics`） |
| ISSUE-P16 | 视觉回归与 catalog 基准稳定性 | P16 | 登录态视觉 smoke 可稳定运行；R01–R04 连续运行无随机 token-budget 假失败；release gate 输出可审计报告 | done（真实 DeepSeek 直连验收、零售模板验证规则修复、R01–R04 4/4 READY、独立 `check:visual-auth` 和失败 E2E case 自动清理均已完成；完整 release gate 通过） |
| ISSUE-P17 | 电商经营分析体验与生成看板视觉升级 | P17 | 商品运营/经营情报有统一返回入口；桌面与移动端视觉通过；生成看板形成“总览→趋势→异常→拆解→行动”闭环，所有金额/库存来源显式标注；模板校验、类型检查与 retail e2e 通过 | in-progress（本切片按可访问的相关电商 BI 方案建立指标与分析路径；用户提供的知乎原文直连返回 403、浏览器加载超时，未将其当作已核验内容；本轮新增 UV 去重口径、中文优先指标标签及移动端溢出修复） |
| ISSUE-P18 | 零售看板数据分析深度：用户漏斗、类目诊断与日报异动 | P17 | 漏斗同时展示事件数与独立用户触达率；类目看板提供高流量低转化诊断；日报异动榜按末日环比绝对值排序并给出分析建议；数据契约、后端测试、模板验证和 retail e2e 通过 | done（实现与验收完成，待用户业务验收；记录见 `docs/review/p18-retail-analytics.md`） |
| ISSUE-P19 | 看板任务闭环：成果入口、Query Rewrite 鉴权诊断与库销比流量转化 | P17 | 成果入口回到最近成果；DeepSeek 401/403 或模型不存在时给出可操作错误；价库看板展示库销比最差 Top 10、页面浏览量（PV）、购买转化率（Buy / PV）；数据契约、模板、类型与运行态验收通过 | done（实现、单测、构建与运行态预览已通过；真实 DeepSeek 端到端验收待有效凭据，当前凭据实测 HTTP 401） |
| ISSUE-P20 | BI 级电商经营看板重构与运营数据集补足 | P20 | 生成看板具备 KPI 总览、日趋势、渠道/类目拆解、库存与转化异常、运营行动建议；数据来源、真实/合成边界和字段口径可追溯；桌面/移动端视觉与 retail e2e 通过 | done（P20 BI 重构已完成；最终 DeepSeek R03 ready，生成 build/数据契约/桌面与移动视觉/预览 HTTP 200 全通过；证据见 `tmp/task-e2e-p20-bi-rebuild-final3-latest.json`） |
| ISSUE-P21 | BI 数据质量：动销口径、库存健康汇总与趋势可读性 | P20 | 动销占比基于全量有库存商品的窗口销量；库存风险样本不因库销比地板值导致柱状图失真；日趋势能够区分不同量级指标并保留真实数值；后端、模板、生成数据和 retail e2e 通过 | done（1,000 商品数据重建、动销与库存健康汇总、趋势可读性和漏斗约束已完成；零售基准通过；有效本地登录态下 R01 E2E `ready=1/1`、预览 HTTP 200、全部 artifact checks 通过；测试项目已自动清理） |
| ISSUE-P22 | 合成行为漏斗一致性：购买不能脱离页面浏览 | P20 | 合成行为的商品级/日级 `Fav/Cart/Buy` 均不超过对应 `PV`；全局漏斗、商品池、类目和渠道口径通过回归测试与数据重建验收 | done（商品/类目/渠道/日趋势全量扫描 0 例 `buy > pv`；合成数据测试 14 passed；release gate 全绿；fresh Agent E2E 仍需本地登录凭据） |
| ISSUE-P23 | BI 看板指标图形与用户文案不一致 | P20 | 趋势图不制造指标大小错觉；图例与实际字段一致；UV、PV、Cart、Buy、GMV 和价格估算均用普通用户能理解的说明；商品运营、经营日报和生成看板口径一致 | done（趋势图统一真实数量刻度；文案与实际 PV/Cart/Buy 字段一致；UV、GMV、商品价格说明已改为用户友好表述；生成看板浏览器验收通过；release gate 全绿） |
| ISSUE-P24 | 生成 BI 看板仍有内部术语表头和诊断文案 | P20 | GMV 份额、库存风险数、诊断、流量份额等表头改为完整中文；库存与转化问题给出用户可执行的原因和建议；生成模板、数据动作和验收预览一致 | done（成交总额占比、浏览量占比、需关注库存商品数、原因与建议已统一；商品级诊断已用户化；生成看板浏览器验收通过；release gate 全绿） |
| ISSUE-P25 | “需关注库存商品数”含义和补货边界说明 | P20 | 看板明确该指标是规则提醒而非补货结论；说明库存可售天数、销量、浏览量和购买转化的判断关系；生成看板浏览器验收通过 | done（已明确“需关注”不等于立即补货，并补充库存、销量、浏览量和购买转化的判断说明；类目脚注删除重复边界句，库存健康度说明保留判断依据；浏览器验收通过；release gate 全绿） |
| ISSUE-P26 | task E2E 默认登录凭据与本地认证默认值不一致 | P21 | 未额外传入 E2E 凭据时，脚本应读取认证配置并与本地登录页默认值一致；非 loopback 地址必须显式配置凭据；真实零售 E2E 通过 | done（task E2E 与视觉检查辅助器统一优先读取 `SHOPGATE_TASK_E2E_*`，再回退到 `SHOPGATE_AUTH_ADMIN_*`，最后使用本地登录页默认值；非 loopback 地址拒绝未完整配置凭据；R01 真实 E2E 通过） |
| ISSUE-P27 | 电商数据契约与数据集扩展 | P17 | 在保留现有真实行为数据的基础上，补充可追溯的用户、会话、渠道、活动、成本、库存快照和订单字段；真实与合成边界、生成规则和限制可审计；现有 4 项能力回归不退化 | done（追加式 schema、`dataset_id` 隔离、可重复生成 CLI、契约 API、1,000 商品/30 天演示数据和 `data_quality_scans` 质量门已完成；v1 五个核心接口 smoke 5/5，零售 E2E 30 case/4 能力保持 ready=1/1；证据见 [`docs/review/p27-data-contract.md`](docs/review/p27-data-contract.md)） |
| ISSUE-P28 | 电商经营分析能力扩展 | P17 | 用户漏斗与留存、RFM、渠道/活动归因、毛利/利润、补货预测、商品生命周期和价格弹性形成可运行能力；每项能力有数据缺口提示、看板模板、后端聚合、E2E case 和桌面/移动验收 | in-progress（已完成 RFM、渠道/活动、毛利、库存健康、商品经营阶段、价格带与价格弹性边界 7 个后端接口；新增 `/analytics-workbench` BI 工作台、Agent 下钻接口/allowlist 和 `analytics-bi` 生成模板第一阶段；商品阶段支持全量分页、四阶段筛选和规则说明；P28 R23 真实生成任务单例 E2E 已通过；真实 DeepSeek 聊天单轮与第二轮追问均已确认 `answer_ready`、durable job `completed` 且无预览；本轮为新生成数据集补充确定性促销价格观察，后端、工作台和生成模板按 `estimated`/`insufficient_data_for_elasticity` 状态展示价格弹性参考或数据缺口；留存、补货预测、实验级价格弹性与数据集导入联动仍未完成，后者另见 ISSUE-P31；证据见 [`docs/review/p28-analytics-capabilities.md`](docs/review/p28-analytics-capabilities.md)） |
| ISSUE-P29 | Skills 与评测语料功能级电商化 | P8/P9 | `commerce-market-data`、`commerce-master-data`、`commerce-rule-review`、`commerce-metrics`、`commerce-data-registry`、`commerce-entity-resolver` 的 scripts/body 不再依赖金融指标；judge/mutation/replay 使用零售语料；registry/lock/tgz/不可变快照同步 | done（六个领域 Skill 已改为数据集、商品、行为、库存、GMV 和经营规则口径；旧金融脚本与参考合同移除，版本升至 1.1.0；registry、capsule、lock、当前 tgz 与 1.1.0 不可变快照同步；task E2E 默认集和 triad Query Rewrite 语料改为零售，mutation/replay 快照改为 dataset/item/behavior 口径；门禁与 54 个 eval 单测通过。运行契约 fixture 中保留的金融兼容接口属于 P13/P14 历史测试边界，不作为零售 Agent 能力投影） |
| ISSUE-P30 | 电商 Agent 任务闭环与 BI 交互增强 | P17 | 支持自然语言多轮下钻、商品/类目/渠道筛选、图表联动、解释口径、行动建议和用户可理解的限制说明；不把缺失数据伪装成结论；新增真实零售 E2E 和视觉验收 | in-progress（承接金融 Agent 的多维比较、证据追踪、风险诊断和策略解释能力，但不恢复金融领域代码；已修复“只做问答仍生成看板”、生成完成后对话视图被轮询切回看板、问答模式显示 `dashboard-visualization`、跨能力全库上下文丢失、首页默认漏斗覆盖库存问答、Agent Runtime 5 秒事务超时、问答 durable job 保持 `running` 以及 answer-ready 后前端仍可继续排队等问题；真实 DeepSeek 单轮与第二轮追问已通过，第二轮在缺少商品级行为明细时正确给出数据边界；后续继续补齐图表联动、更多商品级证据和数据集联动） |
| ISSUE-P31 | 电商数据集选择与导入后分析联动 | P17 | BI 工作台提供数据集选择器，展示窗口、来源、行数和合成字段；切换数据集后所有分析视图同步读取目标 `dataset_id`；数据集导入完成后自动刷新可用数据集与当前分析，按配置异步触发看板生成；刷新/生成结果有状态、失败原因和证据记录，不重复生成、不覆盖用户正在查看的其他数据集 | in-progress（已完成选择器、自动刷新、受控合成数据集导入、最近任务历史、标准行为事件 CSV Web 上传、`dataset_id` 隔离的行为明细持久化、商品级行为接口、导入后 `analytics-bi` 配置任务，并修复 Agent 预取硬编码旧数据集的问题：工作台选择会写入当前浏览器上下文，聊天任务将该 `datasetId` 固化到 run plan 和各扩展分析请求；CSV 之外的第三方连接器、配置清单到 Agent 持久看板预览的跨服务编排仍待后续片，验收记录见 [`docs/review/p31-dataset-linkage.md`](docs/review/p31-dataset-linkage.md)） |
| ISSUE-P32 | 导入任务到 Agent 看板的跨服务持久化编排 | P17 | 数据集导入/更新后，在明确的 `project_id` 范围内消费 `analytics-bi` 配置清单；任务具备 outbox/幂等键、失败重试和证据链；Agent 生成并验证持久预览，任务中心可打开正确数据集且不覆盖其他项目或数据集 | open（P31 已生成并验证配置清单，但当前独立工作台没有项目绑定，不能安全猜测应启动哪个 Agent 项目；下一片先补项目绑定和跨服务事件合同，再接 Agent 生成、验证和持久预览 URL） |

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
| `Quant*` 平台标识符（generation/eval/scaffold 等剩余模块；注意 `Quantity` 不动） | 待继续拆分 | P14 |
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
