# ISSUE-P29 Skills 与评测语料功能级电商化验收

## 范围

本 issue 只处理六个领域 Skill 的运行语义和评测语料，不修改已经由 P13/P14 归档或仍被兼容测试使用的历史金融接口。

已完成：

- `commerce-data-registry`：以 `dataset_id`、窗口、来源、行数和数据质量选择零售分析端点；删除行情 provider、股票池和 K 线路由。
- `commerce-entity-resolver`：解析商品、类目、渠道和活动实体；同优先级候选继续要求澄清。
- `commerce-market-data`：读取行为、商品、类目和日指标；新增行为事件和漏斗顺序校验。
- `commerce-master-data`：组织商品主数据、价格、库存、属性和合成字段；新增商品经营阶段分层脚本。
- `commerce-metrics`：新增漏斗转化、库存健康、库销比和日趋势脚本；移除收益、技术、相关性和流动性计算。
- `commerce-rule-review`：校验 PV/收藏/加购/购买、GMV=购买量×实际价格和库存分母边界；移除回测结果合同。

## 发布同步

六个领域 Skill 均升至 `1.1.0`，并同步更新：

- `.pi/skills.registry.json`
- `config/pi-agent-skill-capsules.json`
- `.pi/skills.lock.json`
- `.pi/skill-packages/*.tgz`
- `.pi/skill-packages/versions/*/1.1.0.tgz`
- `.pi/skills.changelog.json`

旧的金融脚本名和参考合同已从当前 Skill 树移除，SKILL.md 会直接导航到新的零售资源。

## 评测语料

- `config/evals/task-e2e-v1.json` 已删除，`check-task-e2e-campaign` 默认使用 30 条 `task-e2e-retail-v1`、4 个零售能力的数据集。
- triad Query Rewrite 题目已替换为商品、类目、库存、漏斗和经营日报问法。
- mutation fixture、snapshot contract 和 shadow replay 测试改用 `dataset_id`、`item_id`、`behavior_events`、实际/合成价格模式和零售安全文案。
- `commerce-e2e-suite` 的场景映射改为 funnel/catalog/inventory 与零售 capability。

## 验收结果

- `npm run type-check`：通过。
- `npm run check:skills`：通过，12 个规范 Skill、14 个可执行脚本。
- `npm run check:eval-datasets`：通过，30 条零售 case，最近 DeepSeek 证据 `ready=1/1`。
- `npm run check:benchmark-coverage`：通过。
- `npm run check:eval-judge-calibration`：通过。
- `npm run check:eval-mutations`：通过。
- `npm run test:unit -- src/lib/eval`：`54 passed`。

## 后续边界

P29 不把历史契约 fixture、通用平台类型和 P30/P31/P32 的 Agent 交互编排混入本 issue。下一项按顺序进入 P28 剩余能力验收与数据能力补齐，再进入 P30 的图表联动和多轮下钻增强。
