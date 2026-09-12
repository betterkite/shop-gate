# 零售实体解析合同

候选至少包含 `entity_id`、`name`、`kind` 和 `source`。`kind` 只能是 `item`、`category`、`channel` 或 `campaign`。

解析优先级为精确名称/标识，其次为实体类型顺序。没有候选返回 `not_found`；同优先级多个候选返回 `ambiguous`，并将完整候选交给用户选择。

```json
{
  "status": "resolved",
  "query": "轻薄羽绒服",
  "selected": {"entity_id": "item-001", "name": "轻薄羽绒服", "kind": "item", "source": "commerce-data"},
  "clarification_candidates": []
}
```

解析后的实体标识必须原样写入 run plan 和 evidence，不得换成股票代码、市场或资产类型。
