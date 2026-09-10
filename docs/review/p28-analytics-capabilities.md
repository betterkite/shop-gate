# ISSUE-P28 电商经营分析能力扩展（首个切片）

## 本轮范围

本轮从 P28 进入可运行的后端分析切片，使用 `retail-demo-expanded-v1` 的扩展数据契约，不修改现有 v1 行为漏斗和商品/类目接口：

- 用户 RFM：用“距最近购买天数、窗口内订单数、订单净金额”分为高价值、稳定复购、新近购买和流失风险；
- 渠道/活动归因：返回会话、独立用户、订单、订单转化和净销售额；明确这只是合成会话归因；
- 毛利分析：返回销售额、退款、合成成本、毛利和毛利率；明确 GMV/销售额不等于真实利润；
- 库存健康：返回结存、平均日销量、可售天数和“库存正常/库存积压/缺货风险/有库存但无销量”标签；明确不能单独替代补货判断；
- 所有接口返回数据集契约、`synthetic=true` 和用户可理解的限制说明。

## 新增接口

| 接口 | 作用 |
| --- | --- |
| `/api/v1/commerce/analytics/overview` | 扩展数据集订单、买家、销量、净销售额和最近质量扫描 |
| `/api/v1/commerce/analytics/rfm` | 用户 RFM 分群与示例用户 |
| `/api/v1/commerce/analytics/channel-campaign` | 渠道/活动会话与订单转化 |
| `/api/v1/commerce/analytics/profit` | 合成成本下的渠道毛利 |
| `/api/v1/commerce/analytics/inventory` | 商品库存健康与可售天数 |

这些接口已加入 commerce API allowlist 和能力发现；商品生命周期、价格弹性、前端 BI 看板联动、多轮 Agent 下钻仍未完成。

## 运行态证据

针对 `dataset_id=retail-demo-expanded-v1` 的 5 个接口 smoke：`5/5 passed`。

关键结果：

- 净销售额：`1,335,246.87`（合成成交价减合成退款）；
- 有订单用户：`963`；
- 渠道/活动聚合行：`4`；
- 合成毛利：`465,792.66`；
- 库存分析商品：`1,000`。

所有响应均包含限制说明，且明确 `synthetic=true`。

## 门禁

- commerce-data ruff：通过；
- commerce-data pytest：`23 passed`；
- `npm run type-check`：通过；
- `npm run check:docs`：通过，55 个 Markdown、212 个本地链接；
- `npm run check:module-boundaries`：通过；
- `npm run check:retail-e2e`：通过，30 条 case、4 项既有能力 `ready=1/1`；
- 相关 Vitest：2 个文件、4 tests passed。

## 当前边界

这是 P28 的首个后端能力切片，不代表已经完成完整电商 BI。当前仍缺真实订单/成本/库存、活动平台回传和实验对照；后续需要补商品生命周期、价格弹性、看板模板和 Agent 多轮下钻，并为每项能力增加真实零售 E2E 与视觉验收。
