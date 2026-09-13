---
name: run-planner
description: Interpret the platform-created Shop Gate retail run plan, validate intent completeness, and guide the next data and dashboard step without modifying platform-owned artifacts.
---

# Shop Gate 运行规划能力

本 Skill 负责理解平台生成的零售经营任务，检查问题是否具备执行所需的实体、窗口、分析方向和输出方式，并把后续取数、证据与看板步骤交给正确的能力。平台维护 `.data-agent/**`；本 Skill 只能读取，不能改写。

计划字段、澄清门禁和上下文覆盖规则见[零售运行计划契约](references/run-plan-contract.md)。

## 意图澄清

可以运行确定性的辅助脚本：

```bash
python .pi/skills/run-planner/scripts/intent_clarifier.py \
  --question "库销比最高的商品有哪些？" \
  --capability "inventory_health"
```

脚本只输出 JSON，不联网、不写文件。它用于发现缺口，最终门禁仍以平台的 `retail-run-plan.json` 为准。

需要追问的典型缺口：

- 用户要求比较，却没有给商品、类目、渠道或活动范围。
- 用户要求某个商品的分析，但名称/编号无法唯一确定。
- 用户要求趋势，却没有明确时间窗口且数据集也没有可用默认窗口。
- 用户要求利润、留存或价格弹性，但数据合同不包含必要字段。

不应追问的情况：

- 已明确给出商品、类目、渠道、活动或用户分群，缺少的只是展示方式。
- 用户是在继续修改当前看板，且没有指定新的数据集、实体或窗口；此时继承上一轮上下文。
- 只缺输出形式时，默认返回可核对的经营分析和明细入口。

## 多轮上下文

同一项目的后续问题如果使用“这些商品”“刚才的渠道”“上一张图”等指代，先读取上一轮只读计划并继承：

- `dataset_id`
- `plannedEntities`
- `timeRange`
- `capabilityId`
- `visualization.templateId` 与 `variantId`

新的数据集、实体或时间窗口会覆盖对应字段；没有新值的字段继续沿用。继承后的上下文必须写入后续任务合同，不能只存在模型对话记忆中。

## 只读计划字段

重点核对 `.data-agent/retail-run-plan.json` 的：

- `status`：`planned` 或 `needs_clarification`
- `question`、`capabilityId`、`dataset_id`、`plannedEntities`、`timeRange`
- `dataRequirements`、`analysisSteps`、`visualization`
- `expectedArtifacts`、`validationRules`、`clarification`

如果是 `needs_clarification`，只返回 1–3 个必要问题，停止取数和页面生成。如果是 `planned`，不得重新解析原问题来覆盖平台已确认的实体和窗口。

## 后续能力

- 商品、类目、渠道、活动实体：`commerce-entity-resolver`
- 数据集、行为、库存和订单数据：`commerce-data-registry`、`commerce-market-data`
- 经营指标和规则：`commerce-metrics`、`commerce-rule-review`
- 来源、时效、缺失字段：`data-quality`
- 页面和交互：`dashboard-visualization`

## 禁止事项

- 不跳过 Query Rewrite 和平台计划直接取数。
- 不在计划阶段编造商品、价格、库存、订单或用户数据。
- 不修改、删除、追加或伪造 `.data-agent/**` 的计划、状态、事件和验证报告。
- 不把“提醒”“观察参考”写成确定的补货、定价或经营结论。
