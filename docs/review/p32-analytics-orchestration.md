# ISSUE-P32 跨服务持久化编排（第一片）

## 本轮目标

把 P31 的“数据集导入 → `analytics-bi` 配置清单”从只记录任务，推进为可安全交给 Agent 的项目范围编排合同：

- 导入请求必须显式携带 `project_id`，不从浏览器当前页面、最近项目或默认值推断目标项目；
- 合成导入和 CSV 导入都要求 `idempotency_key`，相同项目、任务类型和幂等键只创建一条任务；重复请求返回原任务，不重复写入数据或重新启动 Worker；
- `commerce.platform_jobs` 保存项目绑定和幂等键；任务状态接口和任务历史接口严格按 `project_id` 查询，避免跨项目泄露任务状态；
- `commerce.analytics_orchestration_events` 作为 durable outbox 保存请求、看板清单就绪、导入完成和失败事件；事件包含项目、数据集、任务、幂等键、版本和顺序号；
- `/api/v1/commerce/orchestration/events` 只读取指定项目的事件，默认只返回未确认事件；Agent 成功消费后通过 `/ack` 写入 `consumed_at`，失败或未确认事件可重试；
- 工作台增加“关联 Agent 项目”输入。未绑定项目时仍可浏览已注册数据集，但导入按钮和该项目任务历史保持禁用/为空，并给出用户可理解的原因。

## 事件合同

事件类型固定为：

| 事件 | 触发时机 | 事件内容 |
| --- | --- | --- |
| `analytics_dataset_import.requested` | 新建合成或 CSV 导入任务 | 原始导入参数和项目/数据集绑定 |
| `analytics_dashboard_generation.requested` | 质量扫描通过后新建看板配置任务 | 来源导入任务、模板 `analytics-bi` |
| `analytics_dashboard_manifest.ready` | 配置清单生成并质量校验通过 | 清单、契约版本、窗口、质量扫描 ID 和视图集合 |
| `analytics_dataset_import.completed` | 导入任务完成 | 质量扫描、行数、看板配置任务状态 |
| `analytics_dataset_import.failed` | 导入任务失败 | 可展示的失败原因 |

事件表的唯一键保证同一项目、幂等请求和事件类型不重复；同一任务的 `sequence` 维持消费顺序。`consumed_at` 是消费者确认时间，不是生产时间，因此没有确认的事件仍会出现在默认查询中。

## 验收口径

- Python 单测覆盖项目/幂等键规范化、缺失和非法值拒绝；
- commerce-data ruff、后端全量单测、前端类型检查、Lint、文档检查和 `git diff --check` 通过；
- 数据库初始化可重复执行，新增 SQL 不创建跨数据库外键；
- API 契约验证：没有 `project_id` 的导入被拒绝；带项目 ID 的请求返回任务；重复请求返回相同 `job_id` 且 `idempotent_replay=true`；错误项目读取任务返回 404；事件列表不会返回其他项目；重复 ack 保持成功且不改变原始事件；
- 本片只完成“项目绑定 + 幂等事件合同 + 可审计状态”。Agent 消费事件、生成持久预览、验证预览并返回可打开 URL，仍是 P32 下一片，不把 `preview_ready=false` 的配置清单误报为最终看板。

## 本片实际验收证据（2026-09-14）

- commerce-data 单测：12 passed；后端全量单测：63 passed；前端单测：187 个文件、1040 passed、25 skipped。
- 前端 `type-check`、Lint（0 error，保留 2 条仓库既有 warning）、生产构建、文档链接检查、后端架构检查、服务目录检查和脚手架模板检查均通过；模板检查结果为 6 passed。
- 运行态 API 验收确认：同一项目与幂等键复用同一 `job_id`，重复请求返回 `idempotent_replay=true`；换项目读取任务和确认事件均返回 404；事件可按项目列出并成功 ack；缺少项目绑定的导入返回 422。
- 运行态验收产生的临时数据集、任务、质量扫描、契约和 outbox 事件已清理，查询该项目的事件列表为空。
- 数据库初始化和新增 SQL 可重复执行；`git diff --check`、Python 格式检查和全部文档本地链接检查通过。

## 已知边界

1. `project_id` 是主应用的外部项目 ID；当前 commerce-data 独立数据库无法在本地事务内校验主应用授权，主应用调用方仍需先完成项目权限校验。
2. 本片的 Agent 消费者尚未接入，因此真实事件在 `/orchestration/events` 中保持未确认是预期状态。
3. 导入入口仍只接受受控合成参数或标准五列行为事件 CSV；第三方连接器和真实来源注册另按 P31 约束推进。
