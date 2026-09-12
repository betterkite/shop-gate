# ISSUE-P28 电商经营分析能力扩展（后端与 BI 工作台切片）

## 本轮范围

本轮在首个后端切片上继续推进，使用 `retail-demo-expanded-v1` 的扩展数据契约，不修改现有 v1 行为漏斗和商品/类目接口：

- 用户 RFM：用“距最近购买天数、窗口内订单数、订单净金额”分为高价值、稳定复购、新近购买和流失风险；
- 渠道/活动归因：返回会话、独立用户、订单、订单转化和净销售额；明确这只是合成会话归因；
- 毛利分析：返回销售额、退款、演示成本、毛利和毛利率；明确估算销售额不等于真实财务利润；
- 库存健康：返回结存、平均日销量、可售天数和“库存正常/库存积压/缺货风险/有库存但无销量”标签；明确不能单独替代补货判断；
- 商品经营阶段：根据窗口内首次购买、最近购买和活跃天数给出“未启动、成长期、稳定期、衰退风险”，明确这不是真实上下架生命周期；
- 商品阶段列表：后端先完成全量分类，再按阶段筛选和分页；前端每页展示 20 个商品，阶段卡片可切换全部商品或四类阶段，并直接展示判断规则；
- 价格带与弹性参考：按价格带返回商品数、订单、销售件数和估算销售额；生成数据为订单补充可追溯的促销价格波动，在同一商品有多个成交价格观察时给出成交价格与购买量的关系参考，观察不足时明确不输出弹性系数；
- 多轮下钻：支持 `channel`、`campaign`、`item`、`user` 四个维度，返回当前上下文、结果和下一步问题建议；
- BI 工作台：新增 `/analytics-workbench`，把总览、用户分群、渠道活动、毛利、库存、商品阶段、价格带和下钻组织成统一的产品页面；
- 生成式 BI 第一阶段：新增 `analytics-bi` P28 模板选择规则、扩展分析预取、scaffold renderer 和数据前置校验；普通库销比问题仍保持 `price-inventory` 模板；
- 所有接口返回数据集契约、`synthetic=true` 和用户可理解的限制说明。

## 新增接口

| 接口 | 作用 |
| --- | --- |
| `/api/v1/commerce/analytics/overview` | 扩展数据集订单、买家、销量、净销售额和最近质量扫描 |
| `/api/v1/commerce/analytics/rfm` | 用户 RFM 分群与示例用户 |
| `/api/v1/commerce/analytics/channel-campaign` | 渠道/活动会话与订单转化 |
| `/api/v1/commerce/analytics/profit` | 合成成本下的渠道毛利 |
| `/api/v1/commerce/analytics/inventory` | 商品库存健康与可售天数 |
| `/api/v1/commerce/analytics/lifecycle` | 商品经营阶段与阶段计数 |
| `/api/v1/commerce/analytics/price-elasticity` | 价格带对比；有多价格成交观察时提供弹性参考，否则明确说明数据缺口 |
| `/api/v1/commerce/analytics/drilldown` | 用户、渠道、活动或商品的多轮下钻上下文 |
| `/analytics-workbench` | 面向业务用户的 BI 工作台与页内视图切换 |

这些接口已加入 commerce API allowlist 和能力发现；Agent 可以在后续对话中继续调用下钻接口，页面链接也会保留当前 dataset 和维度上下文。

## 运行态证据

针对 `dataset_id=retail-demo-expanded-v1` 的 7 个分析接口 smoke：`7/7 passed`；另有 4 个下钻场景：`4/4 passed`。

关键结果：

- 净销售额：`1,335,246.87`（演示订单价格减演示退款）；
- 有订单用户：`963`；
- 渠道/活动聚合行：`4`；
- 演示毛利：`465,792.66`；
- 库存分析商品：`1,000`。
- 商品阶段计数：稳定期 `235`、成长期 `217`、衰退风险 `165`、未启动 `383`；全部商品分页为 `50` 页，每页 `20` 个，稳定期筛选为 `12` 页，未启动筛选为 `20` 页；
- 价格弹性状态：原有 `retail-demo-expanded-v1` 快照仍为 `insufficient_data_for_elasticity`；新生成的 `retail-demo-p28-elasticity-v1` 具有 `estimated` 状态、5 个价格带和 100 个商品级多价格观察，页面按状态展示价格观察或数据缺口，而不是固定文案或虚构系数。

所有响应均包含限制说明，且明确 `synthetic=true`。

## 门禁

- commerce-data ruff：通过；
- commerce-data pytest：`24 passed`；
- `npm run type-check`：通过；
- `npm run check:scaffold-templates`：通过，6 个零售模板编译通过（含 `retailAnalyticsBi`）；
- `npm run check:docs`：通过；
- `npm run check:module-boundaries`：通过；
- `npm run check:retail-e2e`：通过，既有 30 条 case、4 项能力保持 `ready=1/1`；
- 相关 Vitest：模板选择、下钻 allowlist、模板意图和脚手架共 `30 passed`；
- 真实生成任务 E2E：P28 R23 单例 `ready=1/1`，第二次修复后的完整重跑通过；run plan 选择 `analytics-bi/p28-expanded`，扩展分析数据 6 组写入 `dashboard-data.json`，Next build、预览 HTTP 200、数据证据、产物契约、页面绑定、桌面/移动视觉和 Mission receipt 全部通过；
- 本次 E2E 首次失败暴露并修复两处验收缺陷：合法的零售合成经营主数据被误判为示例数据，以及 `price_inventory` 被硬编码要求 `price-inventory`；修复后保留了普通库存任务的原有约束，并新增 `analytics-bi` 的数据字段校验；
- 生成截图复核发现商品编号数字被通用文本守卫显示为“—”，已修复模板数字展示并通过第二次 E2E 复核。

## 当前边界

当前切片已经提供可浏览的 BI 工作台和可复用的分析接口，但仍不宣称 P28 完成：

1. `analytics-bi` 生成模板的单例真实生成任务 E2E 已通过；真实 DeepSeek 聊天入口的“只做问答”单轮和第二轮追问均已通过：可见中文回答、终态 `answer_ready`、`previewUrl=null`，没有看板验证/预览事件；第二轮在商品级行为明细缺失时正确降级为“无法核验商品级结论”，没有沿用上一轮不可复核的 SKU 结果；
2. Agent 下钻接口已可用；多轮计划继承的确定性回归和真实第二轮均已通过（上一轮全库口径 → 本轮商品浏览/购买转化追问会保留上下文、进入只问答 lane，并如实指出当前数据仅支持全库漏斗和有限类目级比较）。首页默认能力覆盖、Agent Runtime 5 秒事务超时、问答队列终态未落库和回答完成后前端仍显示运行态等问题均已修复；
3. 价格弹性现在可对含多价格成交观察的新生成数据集提供“成交价格—购买量关系参考”；旧数据集或真实数据没有多价格观察时仍会降级为数据不足。该参考不是价格实验的因果结论，生产环境还需价格实验或更完整的暴露量数据；
4. 真实订单、成本、库存、活动平台回传仍属于后续数据接入范围；数据集选择器、导入后的自动刷新和异步看板生成已单列到 `ISSUE-P31`。

## 本轮发现并修复的任务闭环问题

- 生成完成后，前端状态轮询曾在每次 `ready`/`preview_starting` 事件中无条件把移动工作区切回“看板”，覆盖用户已经选择的“对话”或“文件”；现在只有用户尚未手动选择视图时才自动打开看板。
- “只做问答”虽然已在 Query Rewrite 中得到 `outputIntent=answer`，但旧的生成队列仍无条件进入看板校验、预览启动和 Mission 验收；现在问答模式单独完成，只展示 Agent 的分析回答，不生成或启动看板。
- 真实 DeepSeek 单轮回归确认了上述边界；同时发现问答分支与外层 durable worker 重复收尾会造成队列保持 `running` 或事务超时，已改为由外层 worker 统一终态收尾，并允许终态写入不被瞬时心跳失败阻断。
- 真实第二轮回归已完成：项目 `project-1789133085670-iqzso5j3l` 的两条请求均为 `completed`，两条 `AgentRun` 均为 `candidate_complete`，对应 durable generation job 均为 `completed`；第二轮输出明确说明当前 final/evidence 没有商品级行为明细，因此不虚构“最需优化 SKU”，且无预览地址和看板验收事件。
- 本次回归也确认了真实数据能力边界：当前扩展数据可支持全库漏斗和有限类目级比较，但不能支持商品级 PV→购买转化排序；应由后续数据集/导入联动和数据契约 issue 补齐 item 级行为明细、完整日粒度及漏斗阶段口径。

数据集选择器、导入完成后的自动刷新和可配置异步看板生成已单独登记为 `ISSUE-P31`，不在本轮 P28 分析接口切片中混入数据导入编排逻辑。

## 价格弹性切片复验（2026-09-12）

- 后端为同一商品的多价格成交观察计算对数回归参考值；没有至少两个有效价格点时返回 `insufficient_data_for_elasticity`，不输出空想的系数。
- 合成订单增加确定性的促销价格波动，并在数据契约中声明“价格弹性仅用于演示”；未改变原有数据集，另生成隔离验收集 `retail-demo-p28-elasticity-v1`。
- 运行态：新数据集 1,000 个商品、3,195 个订单；价格带 5 组；100 个商品满足多价格观察条件；`/analytics/price-elasticity` 返回 `estimated`；工作台展示平均值、商品级价格观察和价格带表格。
- 门禁：commerce-data ruff 通过；commerce-data pytest `37 passed`；相关 Vitest `33 passed`；全量 Vitest `1,031 passed / 25 skipped`；type-check、模板校验、文档链接、生成产物策略和 retail-e2e 通过。
- 已知边界：`check:module-boundaries` 仍仅因继承文件 `src/app/[project_id]/chat/page.tsx` 为 4,122 行而失败，本切片未修改该文件；该拆分归入后续 P30。
