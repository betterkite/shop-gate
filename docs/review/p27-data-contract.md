# ISSUE-P27 数据契约与扩展数据集验收

## 目标

在不改写现有 `commerce.user_behavior_events`、`commerce.items` 和日聚合的前提下，提供一个按 `dataset_id` 隔离、可追溯、可重复生成的电商经营分析演示数据集，为后续 P28 分析能力提供字段基础。

## 本次交付

- 新增 `sqls/004-commerce-analytics-contract.sql`：
  - `dataset_contracts`
  - `dataset_user_profiles`
  - `dataset_sessions`
  - `dataset_channels`
  - `dataset_campaigns`
  - `dataset_item_economics`
  - `dataset_orders`
  - `dataset_inventory_snapshots`
- 新增 CLI：`generate-synthetic-analytics-dataset`。
- 新增只读接口：`GET /api/v1/commerce/datasets`，支持 `dataset_id` 过滤。
- Agent commerce API allowlist 和零售能力目录已加入数据集契约接口。
- 每条扩展记录都带 `dataset_id`、`source`、`synthetic`；契约记录版本、时间窗口、种子、行数、生成规则和限制。

## 实际运行证据

命令：

```bash
npm run db:init
uv run --project services/commerce-data shopgate-commerce-import \
  generate-synthetic-analytics-dataset \
  --dataset-id retail-demo-expanded-v1 --users 1000 --items 1000 \
  --days 30 --seed 20251203 --end-day 2025-12-03
```

契约返回的行数：

| 数据 | 行数 |
| --- | ---: |
| 用户画像 | 1,000 |
| 渠道 | 4 |
| 活动 | 4 |
| 会话 | 19,295 |
| 商品经济字段 | 1,000 |
| 订单 | 3,119 |
| 库存日快照 | 30,000 |

数据库核验：

- `dataset_id=retail-demo-expanded-v1` 的扩展数据均为 `source=synthetic_market_scenario_v1`、`synthetic=true`；
- 库存结存负数为 0；
- 订单孤儿会话为 0；
- 相同参数第二次运行成功，行数仍为上述结果，未产生重复数据；
- `GET /api/v1/commerce/datasets?dataset_id=retail-demo-expanded-v1` 返回契约、合成字段、生成规则和限制。

数据质量扫描：

```bash
uv run --project services/commerce-data shopgate-commerce-import \
  scan-analytics-dataset --dataset-id retail-demo-expanded-v1
```

最近一次扫描 `severity=ok`、`issue_count=0`，并已写入 `commerce.data_quality_scans`。行数、来源标记、订单会话关联、订单商品关联、库存滚动、库存非负和商品经济字段约束全部通过。

现有 v1 能力回归：`/meta`、`/funnel`、`/categories/top`、`/inventory-risk`、`/summary` 五个接口在真实 UserBehavior 窗口 `2017-11-25`～`2017-12-03` 上均返回 HTTP 200；`npm run check:retail-e2e` 仍通过，30 条零售 case、4 项能力的最近运行证据保持 `ready=1/1`。

## 门禁

- `uv run ruff check src tests`：通过；
- `uv run pytest -q`：21 passed；
- `scan-analytics-dataset`：`severity=ok`、`issue_count=0`；
- `npm run type-check`：通过；
- `npm run check:docs`：通过，54 个 Markdown、212 个本地链接；
- commerce API / BI dataset 相关 Vitest：2 个文件、4 tests passed。

## 尚未宣称的能力

本次只完成数据契约和数据底座，不代表已经完成 P28。画像、渠道/活动归因、成本、退款、履约和库存快照均为合成数据；订单由合成 `buy` 事件派生，不能用于真实收入确认、真实库存判断或真实活动效果结论。P28 仍需为这些字段建立分析聚合、解释口径和数据不足提示。
