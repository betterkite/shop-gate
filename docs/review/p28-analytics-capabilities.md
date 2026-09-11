# ISSUE-P28 电商经营分析能力扩展（后端与 BI 工作台切片）

## 本轮范围

本轮在首个后端切片上继续推进，使用 `retail-demo-expanded-v1` 的扩展数据契约，不修改现有 v1 行为漏斗和商品/类目接口：

- 用户 RFM：用“距最近购买天数、窗口内订单数、订单净金额”分为高价值、稳定复购、新近购买和流失风险；
- 渠道/活动归因：返回会话、独立用户、订单、订单转化和净销售额；明确这只是合成会话归因；
- 毛利分析：返回销售额、退款、演示成本、毛利和毛利率；明确估算销售额不等于真实财务利润；
- 库存健康：返回结存、平均日销量、可售天数和“库存正常/库存积压/缺货风险/有库存但无销量”标签；明确不能单独替代补货判断；
- 商品经营阶段：根据窗口内首次购买、最近购买和活跃天数给出“未启动、成长期、稳定期、衰退风险”，明确这不是真实上下架生命周期；
- 价格带对比：按价格带返回商品数、订单、销售件数和估算销售额；数据只有每个商品一个价格观察值时，明确不输出价格弹性系数；
- 多轮下钻：支持 `channel`、`campaign`、`item`、`user` 四个维度，返回当前上下文、结果和下一步问题建议；
- BI 工作台：新增 `/analytics-workbench`，把总览、用户分群、渠道活动、毛利、库存、商品阶段、价格带和下钻组织成统一的产品页面；
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
| `/api/v1/commerce/analytics/price-elasticity` | 价格带对比；缺少多价格观察时不伪造弹性系数 |
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
- 商品阶段计数：稳定期 `235`、成长期 `217`、衰退风险 `165`、未启动 `383`；
- 价格弹性状态：`insufficient_data_for_elasticity`，页面展示数据缺口而不是虚构系数。

所有响应均包含限制说明，且明确 `synthetic=true`。

## 门禁

- commerce-data ruff：通过；
- commerce-data pytest：`23 passed`；
- `npm run type-check`：通过；
- `npm run check:docs`：待本轮最终门禁复跑；
- `npm run check:module-boundaries`：通过；
- `npm run check:retail-e2e`：待本轮最终门禁复跑，既有 30 条 case、4 项能力不得回归；
- 相关 Vitest：新增 Agent 下钻 allowlist 测试，待本轮最终门禁复跑。

## 当前边界

当前切片已经提供可浏览的 BI 工作台和可复用的分析接口，但仍不宣称 P28 完成：

1. `/analytics-workbench` 是固定路由的 BI 工作台，尚未接入生成任务产生的“总览→趋势→异常→拆解→行动”看板模板；
2. Agent 下钻接口已可用，但还需要真实聊天链路 E2E，验证“用户追问 → Agent 选择接口 → 保留上轮上下文 → 输出可理解结论”；
3. 价格弹性仍因缺少同一商品多价格时点/实验对照而不能计算；
4. 真实订单、成本、库存、活动平台回传仍属于后续数据接入范围。
