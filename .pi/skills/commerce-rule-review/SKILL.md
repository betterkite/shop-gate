---
name: commerce-rule-review
description: Validate and explain reproducible retail operating rules, metric consistency, and data-quality boundaries.
---

# Shop Gate 零售规则验证

验证漏斗、GMV、库存和商品分层规则是否与输入数据一致，输出可复核的结果和用户友好的限制说明。

## 执行流程

1. 确认 `dataset_id`、时间窗口和数据来源。
2. 读取 [retail-rule-contract.md](references/retail-rule-contract.md)，再执行：

```bash
python3 scripts/validate_retail_rules.py data_file/final/dashboard-data.json
```

3. 校验 PV≥收藏/加购/购买、购买量≤PV、GMV=购买量×实际价格，以及库存和销量的分母边界。
4. 把错误、告警、公式、样本和缺失字段写入 evidence；校验失败时不得声称分析完成。

## 解释边界

- 规则是经营分析口径，不是自动补货或确定性经营决策。
- “需关注库存商品数”表示达到关注规则的商品数量，必须把触发规则写给用户。
- 价格弹性需要多个价格点和可比较购买量；数据不足时只说明缺口。
- 不进行回测，不输出净值、交易明细、收益承诺或金融风险结论。
