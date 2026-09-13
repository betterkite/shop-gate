---
name: commerce-entity-resolver
description: Use this skill to resolve product, category, channel, and campaign names to stable retail entity identifiers before querying data.
---

# Shop Gate 零售实体解析

把用户提到的商品、类目、渠道或活动解析为 `item_id`、`category_id`、`channel_id` 或 `campaign_id`。优先复用 Query Rewrite 已核验的实体，不重复猜测。

## 候选裁决

需要处理同名或多个候选时读取 [entity-resolution-contract.md](references/entity-resolution-contract.md)，然后调用：

```bash
python3 scripts/rank_candidates.py --input '{"query":"轻薄羽绒服","results":[{"entity_id":"item-001","name":"轻薄羽绒服","kind":"item"}]}'
```

只有 `status=resolved` 才能继续取数；`ambiguous` 必须展示候选并请用户选择，`not_found` 必须给出找不到的原因。

## 规则

- 精确名称或标识优先，再按商品、类目、渠道、活动的实体类型排序。
- 保留实体名称、标识、类型和来源，维护用户问题中的顺序。
- 后续请求只能使用已解析的零售实体标识。
- 不因名称格式、品牌词或用户口语而改变零售实体判断。
