# 零售运行计划契约

本参考用于检查计划结构、澄清门禁和多轮上下文继承。

## 最小契约

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必须为 `1` |
| `runId` | 非空字符串，证据文件复用同一值 |
| `status` | `planned` 或 `needs_clarification` |
| `question` | 用户需求，不混入内部执行说明 |
| `capabilityId` | 与当前零售 Profile 的能力一致 |
| `dataset_id` | 数据集切换后必须更新 |
| `plannedEntities` | 商品、类目、渠道、活动或用户范围 |
| `timeRange` | 用户窗口或数据集默认窗口 |
| `dataRequirements` | 真实数据和端点需求 |
| `analysisSteps` | 每一步都有可验证输入/输出 |
| `visualization` | 包含模板、变体和所需模块 |
| `validationRules` | 完成前交给平台逐项校验 |

## 澄清边界

`needs_clarification` 时应包含：

```json
{
  "required": true,
  "reason": "缺少要分析的商品范围。",
  "missing": ["entity"],
  "questions": ["请告诉我商品、类目、渠道或活动名称。"]
}
```

该状态禁止调用经营数据接口、写入最终看板数据或启动页面生成。

## 继承和覆盖

后续问题默认继承上一次已经确认的 `dataset_id`、实体范围、时间窗口和模板。出现以下内容时覆盖对应字段：

- 用户指定新的数据集。
- 用户指定新的商品、类目、渠道、活动或用户分群。
- 用户指定新的起止日期或比较周期。
- 用户明确要求新的分析主题而不是修改现有页面。

继承或覆盖后的字段必须在 run plan、取数请求、最终数据和可打开分析链接中保持一致。
