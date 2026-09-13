---
name: commerce-data-registry
description: Use this skill to discover Shop Gate retail datasets, coverage, fields, and the smallest auditable analytics endpoint.
---

# Shop Gate 零售数据注册

先确认数据集、窗口、来源、记录数和字段质量，再选择经营分析端点。所有结论必须绑定 `dataset_id`，不能把另一个数据集或默认数据集的结果混进当前任务。

## 确定性路由

需要选择端点时读取 [dataset-routing-contract.md](references/dataset-routing-contract.md)，然后调用：

```bash
python3 scripts/select_data_route.py --input '{"operation":"funnel","dataset_id":"retail-demo-p31-acceptance"}'
```

脚本只输出 JSON 决策，不联网、不写文件，也不猜测数据集是否存在。`dataset_discovery` 用于列出可用数据集，其余经营端点必须提供安全的 `dataset_id`。

## 工作流程

1. 先调用 `/api/v1/commerce/datasets` 发现或确认数据集。
2. 调用 `/api/v1/commerce/meta?dataset_id=...` 核对窗口、来源、行数、合成字段和质量告警。
3. 根据问题选择 `/api/v1/commerce/analytics/*` 的最小端点：总览、漏斗、类目、库存、生命周期、价格弹性、利润或下钻。
4. 商品级问题使用商品行为明细端点；无法提供明细时明确说明缺口，不用聚合数字冒充商品证据。
5. 把 `dataset_id`、`source`、`as_of`、`fetched_at`、`row_count` 和 `data_quality` 写入 evidence。

## 禁止事项

- 只读取已登记的零售数据集和经营接口，不调用未登记的外部数据源。
- 不把示例数据、另一数据集或模型推断当作当前数据集事实。
- 不在来源或字段缺失时静默补造数字。
