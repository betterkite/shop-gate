---
name: query-rewrite
description: Consume the platform-owned LLM-first retail query contract before planning, data retrieval, answers, or dashboard generation.
---

# Shop Gate Query Rewrite

本 Skill 消费 `.data-agent/retail-query-rewrite.json`，作为用户表达、运行计划、经营数据和 Agent 之间唯一的语义事实源。模型只负责理解自然语言；商品、类目、渠道和活动身份由独立实体解析服务确认。

字段和状态约束见[经营问题改写契约](references/query-rewrite-contract.md)。

## 工作流

1. 先读取 rewrite 合同的 `execution.strategy`、`execution.llm` 和状态。
2. `llm_primary` 必须是 schema 合法且原文有证据；`llm_unavailable`、`safety_refusal` 或无效输出时失败关闭。
3. 使用 `resolvedEntities`、`dataset_id`、`timeRange`、`analysisFocus`、`outputIntent` 和 `scope`，不要从原问题重新猜测。
4. `ready` 才能继续 `run-planner` 和数据 Skill；`partial` 只有不影响范围时才能继续；`needs_clarification` 必须先追问；`refused` 必须停止。
5. 保留用户原话用于展示，`rewrittenQuery` 只做执行摘要，不当作引用。

## 信任边界

- 平台只调用一次受约束的语义模型，Agent 不再调用第二个模型重写同一问题。
- 模型不能发明实体 ID；候选名称必须出现在原文字面中并通过 Resolver。
- 时间范围、数据集、只读回答和是否生成看板的判断必须有原文证据。
- 模型不可用时不能用关键词规则伪造成功合同。

## 配置和校验

```bash
python .pi/skills/query-rewrite/scripts/validate_query_rewrite.py \
  --input .data-agent/retail-query-rewrite.json
```

模型 provider、model、base URL、credential 环境变量名和 Agent 配置可以记录；密钥本身不能写入合同、日志、证据或页面。

## 完成标准

只有当状态、实体集合、数据集、时间范围、分析重点、能力、输出意图、澄清状态和安全决定一致时，本 Skill 才完成。实际取数、证据和页面分别由后续能力负责。
