# 零售看板数据契约

最终看板数据必须是 JSON 对象，且包含可追溯的 `dataset_id`、`source`、`as_of` 或 `fetched_at`。页面不能把空对象、示例数据或模型猜测当作数据集。

## 最小结构

```json
{
  "dataset_id": "retail-demo-v1",
  "source": "commerce-data",
  "as_of": "2026-09-01",
  "visualization": {
    "template_id": "analytics-bi",
    "variant_id": "operations-overview",
    "required_components": ["kpis", "daily", "items"],
    "rendered_components": ["kpis", "daily", "items"],
    "missing_components": []
  },
  "kpis": {},
  "daily": [],
  "items": [],
  "categories": [],
  "channels": [],
  "inventory": {},
  "profit": {},
  "limitations": []
}
```

## 结构规则

- 至少有一个非空的零售数据区：`kpis`、`daily`、`items`、`categories`、`channels`、`inventory`、`profit`、`lifecycle`、`retention` 或 `price_experiment`。
- 商品、类目、渠道和活动明细使用稳定的 `item_id`、`category_id`、`channel` 或对应名称；当前筛选范围写入 `scope`。
- `visualization.required_components` 中的每一项必须出现在 `rendered_components` 或 `missing_components`，缺失时要说明真实原因。
- 窗口外数据不得用于日趋势；比率、可售天数和利润率保留其计算口径。
- 没有足够数据时使用 `status`、`missing_fields`、`warnings` 和 `limitations` 说明缺口，不填入占位结果。
- 任何字符串都不能包含 `MOCK_DATA`、`SAMPLE_DATA`、`STATIC_QUOTES`，也不能包含密钥、Cookie 或授权值。

## 契约检查

```bash
python scripts/validate_dashboard_contract.py \
  --input data_file/final/dashboard-data.json \
  --expected-template analytics-bi
```

脚本只检查结构、组件、实体覆盖和敏感/示例标记，不代替构建、预览、E2E 或视觉检查。
