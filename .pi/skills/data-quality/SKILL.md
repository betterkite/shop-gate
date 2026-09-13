---
name: data-quality
description: Audit Shop Gate retail data sources, freshness, missing fields, anomalies, and evidence before dashboards or answers.
---

# Shop Gate 数据质量与证据能力

本 Skill 把已经读取的商品、行为、库存、订单、用户和经营数据变成可追溯证据。生成页面或回答问题前，必须检查数据来源、时间窗口、行数、关键字段和限制，并写入 `evidence/sources.json` 与 `evidence/data_quality.json`。

证据字段、状态和失败边界见[零售数据来源与质量证据契约](references/evidence-contract.md)。

## 脚本

```bash
python .pi/skills/data-quality/scripts/assess_data_quality.py \
  --input quality-input.json
```

脚本只输出 JSON，不联网、不写项目文件，也不生成时间戳。发现敏感凭据或结构无效时以非零状态退出。

## 检查内容

1. 数据集身份、来源、统计窗口和读取时间是否存在。
2. 商品、类目、渠道、活动和用户字段是否真的被采集。
3. PV、UV、收藏、加购、购买、价格、库存、成本和订单字段是否完整。
4. 数量、去重用户数、金额、比例、可售天数和利润率是否按正确口径使用。
5. 是否有空数组、窗口外数据、重复事件、购买大于浏览、负库存或异常价格。
6. 价格弹性、留存、利润和补货分析是否具备足够样本；不足时标为 warning 或 error。

## 输出

- `sources.json`：每个数据集的来源、端点、产物路径、更新时间、状态和窗口。
- `data_quality.json`：整体状态、数据集行数、缺失字段、检查项、警告和限制。

`ok` 表示可正常使用，`warning` 表示带限制继续，`error` 表示不能依赖该数据生成结论。任何 evidence 都不得包含 token、Cookie、Authorization、密码、API key 或私人路径。

## 交接

检查完成后把结果交给 `dashboard-visualization` 或回答流程。不要把数据质量说明只写在聊天里，也不要用示例数据掩盖真实缺口。
