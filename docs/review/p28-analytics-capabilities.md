# ISSUE-P28 电商经营分析能力扩展（后端与 BI 工作台切片）

## 本轮范围

本轮在首个后端切片上继续推进，使用 `retail-demo-expanded-v1` 的扩展数据契约，不修改现有 v1 行为漏斗和商品/类目接口：

- 用户 RFM：用“距最近购买天数、窗口内订单数、订单净金额”分为高价值、稳定复购、新近购买和流失风险；先统计全部有订单用户，再按每页 20 个分页展示；
- 用户留存：按用户第一次购买所在周建立 cohort，统计后续各周再次购买人数和留存率；仅使用购买事件，并排除尚未完成 7 日观察窗口的 cohort；
- 渠道/活动归因：返回会话、独立用户、订单、订单转化和净销售额；明确这只是合成会话归因；
- 毛利分析：返回销售额、退款、演示成本、毛利和毛利率；明确估算销售额不等于真实财务利润；
- 库存健康：返回结存、平均日销量、可售天数和“库存正常/库存积压/缺货风险/有库存但无销量”标签；接口先统计全部商品，再按页返回 20 个，工作台可以翻页查看完整库存清单；明确不能单独替代补货判断；
- 补货参考：按可用库存、日均销量、供货周期和目标覆盖天数估算参考补货量；默认假设为 7 天供货周期 + 30 天目标覆盖，输出优先级、原因和公式，不把结果写成采购指令；
- 商品经营阶段：根据窗口内首次购买、最近购买和活跃天数给出“未启动、成长期、稳定期、衰退风险”，明确这不是真实上下架生命周期；
- 商品阶段列表：后端先完成全量分类，再按阶段筛选和分页；前端每页展示 20 个商品，阶段卡片可切换全部商品或四类阶段，并直接展示判断规则；
- 价格带与弹性参考：按价格带返回商品数、订单、销售件数和估算销售额；生成数据为订单补充可追溯的促销价格波动，在同一商品有多个成交价格观察时给出成交价格与购买量的关系参考，商品观察结果按每页 20 个分页展示，观察不足时明确不输出弹性系数；新增显式价格实验观察表和合成对照/处理组模拟，接口只计算两组购买率差异并标注合成实验边界；
- 多轮下钻：支持 `channel`、`campaign`、`item`、`user` 四个维度，返回当前上下文、结果和下一步问题建议；
- BI 工作台：新增 `/analytics-workbench`，把总览、用户分群、用户留存、渠道活动、毛利、库存、商品阶段、价格带和下钻组织成统一的产品页面；
- 生成式 BI 第一阶段：新增 `analytics-bi` P28 模板选择规则、扩展分析预取、scaffold renderer 和数据前置校验；普通库销比问题仍保持 `price-inventory` 模板；
- 所有接口返回数据集契约、`synthetic=true` 和用户可理解的限制说明。

## 新增接口

| 接口 | 作用 |
| --- | --- |
| `/api/v1/commerce/analytics/overview` | 扩展数据集订单、买家、销量、净销售额和最近质量扫描 |
| `/api/v1/commerce/analytics/rfm` | 用户 RFM 分群与示例用户 |
| `/api/v1/commerce/analytics/retention` | 首购周 cohort 与用户留存率 |
| `/api/v1/commerce/analytics/channel-campaign` | 渠道/活动会话与订单转化 |
| `/api/v1/commerce/analytics/profit` | 合成成本下的渠道毛利 |
| `/api/v1/commerce/analytics/inventory` | 商品库存健康与可售天数 |
| `/api/v1/commerce/analytics/replenishment` | 带假设的补货参考与分页清单 |
| `/api/v1/commerce/analytics/lifecycle` | 商品经营阶段与阶段计数 |
| `/api/v1/commerce/analytics/price-elasticity` | 价格带对比、成交价格关系参考，以及有显式实验分组时的购买率差异；缺失实验字段时明确说明数据缺口 |
| `/api/v1/commerce/analytics/drilldown` | 用户、渠道、活动或商品的多轮下钻上下文 |
| `/analytics-workbench` | 面向业务用户的 BI 工作台与页内视图切换 |

这些接口已加入 commerce API allowlist 和能力发现；Agent 可以在后续对话中继续调用下钻接口，页面链接也会保留当前 dataset 和维度上下文。

## 运行态证据

针对 `dataset_id=retail-demo-expanded-v1` 的 9 个分析接口 smoke：`9/9 passed`；另有 4 个下钻场景：`4/4 passed`。新生成的 `retail-demo-p28-elasticity-v1` 另完成留存、补货参考接口和工作台视觉验收。

关键结果：

- 净销售额：`1,335,246.87`（演示订单价格减演示退款）；
- 有订单用户：`963`；
- 用户留存：新生成数据集首购用户 `972`，首购周 `5` 个，完整 7 日观察用户 `960`，7 日留存率 `53.23%`；
- 渠道/活动聚合行：`4`；
- 演示毛利：`465,792.66`；
- 库存分析商品：`1,000`。
- 补货参考：新生成数据集共 `1,000` 个商品，其中优先评估 `13` 个、建议评估 `7` 个、无销量先观察 `378` 个；参考补货商品 `20` 个，默认采用 7 天供货周期和 30 天目标覆盖；
- 商品阶段计数：稳定期 `235`、成长期 `217`、衰退风险 `165`、未启动 `383`；全部商品分页为 `50` 页，每页 `20` 个，稳定期筛选为 `12` 页，未启动筛选为 `20` 页；
- 价格弹性状态：原有 `retail-demo-expanded-v1` 快照仍为 `insufficient_data_for_elasticity` 且没有实验观察；重新生成的 `retail-demo-p28-elasticity-v1` 有 `estimated` 状态、5 个价格带、267 个商品级多价格观察和 2,800 条显式价格实验模拟观察，接口返回 1 个实验模拟结果，页面按状态展示价格观察、实验模拟差异或数据缺口。

所有响应均包含限制说明，且明确 `synthetic=true`。

## 门禁

- commerce-data ruff：通过；
- commerce-data pytest：`50 passed`；
- 用户留存针对性回归：`17 passed`（含 cohort、7 日观察窗口和购买事件口径）；
- `npm run type-check`：通过；
- `npm run check:scaffold-templates`：通过，6 个零售模板编译通过（含 `retailAnalyticsBi`）；
- `npm run check:docs`：通过；
- `npm run check:module-boundaries`：通过；
- `npm run check:retail-e2e`：通过，既有 30 条 case、4 项能力保持 `ready=1/1`；
- `npm run test:unit`：`1,039 passed / 25 skipped`，`186` 个文件通过、`2` 个跳过；
- `npm run check:analytics-workbench-visual`：通过，桌面 `1440×900` 与移动 `390×844` 均验证用户分群分页、留存 cohort 表和筛选联动；
- 留存和补货接入后 R23 单例生成复验：`ready=1/1`、预览 HTTP `200`；最终 `dashboard-data.json` 包含 `datasets.analyticsRetention` 与 `datasets.analyticsReplenishment`，补货参考清单可渲染；验收目录已移出项目；
- task-E2E 登录等待已补齐 network-idle，避免 React 登录表单尚未 hydration 时误判“登录按钮禁用”；修复后 R23 单例再次通过；
- 相关 Vitest：模板选择、下钻 allowlist、模板意图和脚手架共 `30 passed`；
- 真实生成任务 E2E：P28 R23 单例 `ready=1/1`，第二次修复后的完整重跑通过；run plan 选择 `analytics-bi/p28-expanded`，扩展分析数据 8 组写入 `dashboard-data.json`，现在包含用户留存 cohort 和补货参考；Next build、预览 HTTP 200、数据证据、产物契约、页面绑定、桌面/移动视觉和 Mission receipt 全部通过；
- 本次 E2E 首次失败暴露并修复两处验收缺陷：合法的零售合成经营主数据被误判为示例数据，以及 `price_inventory` 被硬编码要求 `price-inventory`；修复后保留了普通库存任务的原有约束，并新增 `analytics-bi` 的数据字段校验；
- 生成截图复核发现商品编号数字被通用文本守卫显示为“—”，已修复模板数字展示并通过第二次 E2E 复核。

## 当前边界

当前切片已经提供可浏览的 BI 工作台和可复用的分析接口，但仍不宣称 P28 完成：

1. `analytics-bi` 生成模板的单例真实生成任务 E2E 已通过；真实 DeepSeek 聊天入口的“只做问答”单轮和第二轮追问均已通过：可见中文回答、终态 `answer_ready`、`previewUrl=null`，没有看板验证/预览事件；第二轮在商品级行为明细缺失时正确降级为“无法核验商品级结论”，没有沿用上一轮不可复核的 SKU 结果；
2. Agent 下钻接口已可用；多轮计划继承的确定性回归和真实第二轮均已通过（上一轮全库口径 → 本轮商品浏览/购买转化追问会保留上下文、进入只问答 lane，并如实指出当前数据仅支持全库漏斗和有限类目级比较）。首页默认能力覆盖、Agent Runtime 5 秒事务超时、问答队列终态未落库和回答完成后前端仍显示运行态等问题均已修复；
3. 价格弹性现在可对含多价格成交观察的新生成数据集提供“成交价格—购买量关系参考”；若契约含有完整对照/处理组、曝光人数和购买人数，还会提供“价格实验模拟参考”。旧数据集或真实数据没有这些字段时仍会降级为数据不足；两类结果都不是自动调价依据，生产环境还需真实实验分组证据和更完整的实验接入；
4. 用户留存现在可按首购周提供 cohort 和 7 日留存参考；补货参考现在按显式假设输出排序和数量，仍需真实采购周期、在途库存和供应商约束才能用于采购决策；
5. 真实实验数据导入、用户级随机分组证据、显著性检验和正式因果分析仍未实现；当前新增的是可审计的合成实验模拟，不得把它或成交价格观察直接解释为真实因果关系；
6. 真实订单、成本、库存、活动平台回传仍属于后续数据接入范围；数据集选择器、导入后的自动刷新和异步看板生成已单列到 `ISSUE-P31`。

## 本轮发现并修复的任务闭环问题

- 生成完成后，前端状态轮询曾在每次 `ready`/`preview_starting` 事件中无条件把移动工作区切回“看板”，覆盖用户已经选择的“对话”或“文件”；现在只有用户尚未手动选择视图时才自动打开看板。
- “只做问答”虽然已在 Query Rewrite 中得到 `outputIntent=answer`，但旧的生成队列仍无条件进入看板校验、预览启动和 Mission 验收；现在问答模式单独完成，只展示 Agent 的分析回答，不生成或启动看板。
- 真实 DeepSeek 单轮回归确认了上述边界；同时发现问答分支与外层 durable worker 重复收尾会造成队列保持 `running` 或事务超时，已改为由外层 worker 统一终态收尾，并允许终态写入不被瞬时心跳失败阻断。
- 真实第二轮回归已完成：项目 `project-1789133085670-iqzso5j3l` 的两条请求均为 `completed`，两条 `AgentRun` 均为 `candidate_complete`，对应 durable generation job 均为 `completed`；第二轮输出明确说明当前 final/evidence 没有商品级行为明细，因此不虚构“最需优化 SKU”，且无预览地址和看板验收事件。
- 本次回归也确认了真实数据能力边界：当前扩展数据可支持全库漏斗和有限类目级比较，但不能支持商品级 PV→购买转化排序；应由后续数据集/导入联动和数据契约 issue 补齐 item 级行为明细、完整日粒度及漏斗阶段口径。

数据集选择器、导入完成后的自动刷新和可配置异步看板生成已单独登记为 `ISSUE-P31`，不在本轮 P28 分析接口切片中混入数据导入编排逻辑。

## 价格实验统计证据切片（2026-09-14）

价格实验结果现在除了展示两组购买率和购买率变化，还返回：

- 购买率变化的 95% 置信区间；
- 两比例近似检验的 p 值；
- 当前样本是否达到最低样本量（每组至少 30 个曝光用户）；
- 用户可理解的判断：样本显示有差异、暂未发现明确差异，或样本较少暂不判断。

这些字段只描述当前对照组与处理组的样本差异，不证明价格造成了变化，也不证明分组确实随机。合成实验继续标注为模拟记录；真实实验仍需接入用户级分组、曝光日志、实验周期和分组完整性证据后，才能进入正式因果分析。

## 用户级分组证据切片（P28 后续，2026-09-14）

新增 `dataset_price_experiment_assignments` 契约表，按 `dataset_id + experiment_id + user_id` 保存用户被分配到对照组或处理组的记录、分配时间、分配方法、来源和 `synthetic` 标记。合成演示数据现在会生成确定性的分组清单，但页面只显示“已记录分组（演示）”，不把它解释为真实随机分流。

价格实验接口会返回分组记录数、对照/处理用户数、分组是否完整、分配方法和来源状态；缺少分组记录、只有一组或未声明随机/哈希分配时，分别显示“未提供用户分组”“分组记录不完整”或“未确认随机分组”。这一步只完成证据契约和边界校验，真实实验文件/平台接入、分层检验和正式因果模型仍属于后续工作。

本地真实落库验收：`retail-demo-p28-assignment-v1` 生成 `80` 条用户分组记录（对照 `39`、处理 `41`），质量扫描 `severity=ok / issue_count=0`；价格实验接口返回 `status=declared_randomized`，但因数据仍为 `synthetic=true`，页面继续按演示分组显示，不把 `p` 值或购买率差异写成真实因果结论。跟进 Issue：[#44](https://github.com/betterkite/shop-gate/issues/44)。

## 真实实验输入校验切片（P28 后续，2026-09-14）

新增 `validate-price-experiment-csv` 只读命令，要求用户分组文件和实验观察文件使用固定表头，
并在写库前检查对照/处理组、用户唯一分组、带时区的分配时间、曝光/购买/件数边界、用户级
分配单元和观察行唯一性。命令输出 `source_kind=observed`、`synthetic=false` 和
`causal_claim=not_verified`，不会连接数据库或修改已有数据集；有效输入只表示数据满足结构
契约，不代表已经证明随机化或因果关系。跟进 Issue：[#46](https://github.com/betterkite/shop-gate/issues/46)。

## 真实实验文件落库切片（P28 后续，2026-09-14）

新增 `import-price-experiment-csv`，在 Issue #46 的只读校验通过后，将用户分组和实验观察
写入指定 `dataset_id`。导入只替换同名 `experiment_id`，检查商品 ID 和契约日期窗口，使用
`synthetic=false` 保存外部来源，并更新数据集的 `source_kind`、行数和限制说明。合成数据集
导入真实实验后标记为 `mixed`，质量扫描允许真实实验行使用外部 source，同时继续检查合成行的
来源标记。重复导入已通过验收，行数保持稳定，质量扫描 `severity=ok / issue_count=0`；
价格实验接口返回真实实验 `synthetic=false`，但同一数据集仍有合成实验时整体状态继续保守显示，
不得把文件导入或显著性结果直接解释为因果结论。跟进 Issue：[#48](https://github.com/betterkite/shop-gate/issues/48)。

## 用户级实验结果证据切片（P28 后续，2026-09-14）

新增 `dataset_price_experiment_outcomes` 和可选 outcomes CSV。导入时校验结果用户必须来自
assignment、分组必须一致、每个实验用户只能有一条结果、日期在契约窗口内且购买/件数边界合法；
质量扫描只对确实声明了 outcomes 的实验检查覆盖率，不会因为同一混合数据集中的合成实验没有
用户结果而阻断真实实验。价格实验接口新增 `outcome_evidence` 和 `causal_readiness`：完整真实
用户结果且分组状态已声明时显示 `ready_for_user_level_review`，否则保持 `aggregate_reference_only`
或 `incomplete_user_outcomes`。该状态表示证据链可复核，不表示已经证明因果效果。跟进 Issue：[#50](https://github.com/betterkite/shop-gate/issues/50)。

## 价格弹性切片复验（2026-09-12）

- 后端为同一商品的多价格成交观察计算对数回归参考值；没有至少两个有效价格点时返回 `insufficient_data_for_elasticity`，不输出空想的系数。
- 新增 `dataset_price_experiment_observations`：合成数据按 100 个商品、14 天、对照/处理两组生成 2,800 条记录，保存价格、曝光人数、购买人数、分组方式和 `synthetic=true`；接口返回 `synthetic_experiment_reference`，明确它只是模拟。
- 真实 R23 重跑（campaign `p28-experiment`）：`ready=1/1`，耗时约 71 秒，`validationStatus=passed`、`missionAcceptanceSatisfied=true`、预览 HTTP `200`；临时项目和报告已移出仓库，未写入正式项目目录。
- 合成订单增加确定性的促销价格波动，并在数据契约中声明“价格弹性仅用于演示”；未改变原有数据集，另生成隔离验收集 `retail-demo-p28-elasticity-v1`。
- 运行态：新数据集 1,000 个商品、3,119 个订单；价格带 5 组；267 个商品满足多价格观察条件；`/analytics/price-elasticity` 返回 `estimated`，并返回 1 个价格实验模拟结果（对照购买率 `2.92%`、处理购买率 `3.44%`）；工作台和生成模板均展示观察性价格关系与实验模拟的区别。
- 门禁：commerce-data ruff 通过；commerce-data pytest `50 passed`；旧全量前端门禁仍需在本轮前端改动后复跑；数据库初始化、质量扫描和真实接口 smoke 通过，实验数据质量 `severity=ok`、`issue_count=0`。
- 已知边界：模块边界门禁当前通过，但仍对 `src/app/[project_id]/chat/page.tsx` 等继承大文件输出拆分建议；本切片不扩大到该文件，后续仍可按 P30 的模块拆分计划治理。
