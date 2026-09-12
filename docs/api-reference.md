# API 总览

这份文档记录 Shop Gate 当前对外和内部页面使用的主要 API。它不是替代源码的逐行说明，而是帮助维护者快速判断“这个页面读的是哪个入口、后端职责在哪里、出问题先看哪一层”。

生成类 API 由 PI Agent `0.82.1` 执行完整多轮工具循环，权限、审批、durable run、Mission 和交付验证由 Shop Gate 承担。所有 Agent API、设置和任务信封只接受规范 CLI 值 `pi`。详见 [PI Agent 采用与治理边界](pi-agent-migration.md)。

## 服务边界

| 服务 | 默认地址 | 代码位置 | 责任 |
| --- | --- | --- | --- |
| Next.js 主应用 API | `http://localhost:3000/api/*` | `src/app/api/` | 项目、聊天、设置、评测、skills、运维和页面聚合数据 |
| commerce-data 数据服务 | `http://127.0.0.1:8000/api/v1/*` | `services/commerce-data/src/shopgate_commerce_data/api.py` | 零售行为漏斗、商品/类目指标、库存风险、渠道聚合与经营汇总 |
| 用户记忆服务 | `http://127.0.0.1:38089/*` | 独立 `evolvable-user-memory` 仓库 | 偏好证据、不可变修订、召回 Trace、上下文投影和可归因 Outcome |
| 预览工作空间 | `http://localhost:4100+` | `data/projects/project-*` | AI 生成项目的 Next.js 预览，不承载平台状态 |

页面原则：

- 页面不直接读取原始数据集；零售数据由 `shopgate-commerce-import` CLI 导入 commerce 事实库，经 commerce-data 服务统一读出。
- Next.js API route 只做请求解析、权限/参数校验、聚合和服务调用。
- 长期事实数据最终写入 PostgreSQL/TimescaleDB；Redis 只做短期缓存。
- 生成工作空间里的数据必须从 `data_file/final/` 和 `evidence/` 读取，不把平台 API 当作隐藏 mock。

## Next.js 主应用 API

### 项目与工作空间

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/projects` | `GET/POST` | 首页工作台 | 项目列表、创建项目和 workspace 索引 |
| `/api/projects/[project_id]` | `GET/PATCH/DELETE` | 首页、项目页 | 单项目状态、元数据和删除 |
| `/api/projects/[project_id]/files` | `GET` | 项目聊天页 | 浏览生成工作空间文件树 |
| `/api/projects/[project_id]/artifact` | `GET` | 预览、运行治理中心 | 读取生成产物或验证报告摘要 |
| `/api/projects/[project_id]/install-dependencies` | `POST` | 项目聊天页 | 生成项目依赖安装 |
| `/api/projects/[project_id]/retry-initialization` | `POST` | 项目聊天页 | 重新初始化失败 workspace |
| `/api/projects/[project_id]/members` | `GET/PUT/DELETE` | 用户管理 | owner/管理员查看、授予和移除项目成员权限 |
| `/api/workspaces/health` | `GET` | 运行治理中心 | 工作空间健康、验证、产物和预览状态 |
| `/api/workspaces/trace` | `GET` | 运行治理中心 | 生成链路 trace、阶段事件和工具调用 |
| `/api/observability/generation` | `GET` | 运行治理中心 | 生成状态、队列、事件和可观测性聚合 |

### 聊天与 Agent Runtime

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/chat/[project_id]/messages` | `GET/POST` | 项目聊天页 | 消息读取和持久化 |
| `/api/chat/[project_id]/stream` | `GET` | 项目聊天页 | SSE 消息流 |
| `/api/chat/[project_id]/act` | `POST` | 项目聊天页 | 启动 Agent 执行、零售数据预取、验证和修复链路 |
| `/api/chat/[project_id]/pause` | `POST` | 项目聊天页 | 暂停当前执行 |
| `/api/projects/[project_id]/agent/approvals` | `GET` | 项目聊天页、运行治理中心 | 按项目、run 和状态列出 bounded public tool approvals |
| `/api/projects/[project_id]/agent/approvals/[approval_id]` | `POST` | 项目聊天页、运行治理中心 | 对 pending mutating tool 提交 `approve`、`edit` 或 `reject`；决策人只来自认证会话 |
| `/api/projects/[project_id]/agent/runs/[run_id]` | `GET` | 运行治理中心 | 分页读取 AgentRun 公共事件、最新 replan checkpoint 和审批时间线 |

核心约束：

- `act` 入口要把用户问题转换为 run plan、数据预取、生成、验证和修复事件。
- `act` 请求是严格 camelCase 合同；未知字段直接返回 `400 INVALID_ACT_REQUEST`，不再接受 snake_case、`cliPreference`、内联 base64 或宿主绝对路径。
- 运行状态只来自 `UserRequest / AgentRun / Mission / GenerationJob`；不再提供旧 CLI Session API 或平行状态表。
- 工具审批仅适用于受信应用显式标记的 mutating tool；原始参数不进入 API。`edit` 请求体为 `{ "decision": "edit", "editedInput": { ... } }`，批准/拒绝只传 `{ "decision": "approve|reject" }`。决策要求 `project.update`，列表与时间线要求 `project.read`。
- 经营结论必须保持辅助决策口径，不输出确定性销量承诺；"保证销量"类请求会在问题改写阶段直接拒绝。
- 如果是宽域商品/类目筛选问题，不应因为缺少明确商品而反复澄清，应走本地商品池（`/items`）筛选。

`POST /api/chat/[project_id]/act` 当前请求体如下：

```json
{
  "instruction": "分析最近的类目流量与转化漏斗，并生成看板",
  "displayInstruction": "分析最近的类目流量与转化漏斗，并生成看板",
  "conversationId": "optional-conversation-id",
  "requestId": "optional-idempotent-request-id",
  "selectedModel": "deepseek-v4-flash",
  "images": [
    {
      "name": "经营数据截图",
      "path": "assets/ops-screenshot.png",
      "mimeType": "image/png"
    }
  ],
  "isInitialPrompt": false,
  "capabilityId": "traffic_funnel",
  "capabilitySelectionSource": "manual"
}
```

`instruction`、`displayInstruction` 和 `images` 至少有一项非空；`images` 最多 8 张。`capabilityId` 和 `capabilitySelectionSource` 是通用 Data Agent 合同，由当前 Agent Profile 解析；零售可选能力为 `traffic_funnel`、`catalog_structure`、`price_inventory`、`daily_brief`。图片必须先通过 `/api/assets/[project_id]/upload` 上传，随后只提交服务端返回的 `assets/<filename>` 相对路径。上传响应使用 `originalFilename`、`publicPath`、`publicUrl`，不返回重复 snake_case 字段。服务端会校验真实文件、图片签名、单图/总大小和 canonical project root，再由 Data Agent 通用层写 manifest；零售领域字段和取数要求由 Retail Domain Pack（`src/lib/domains/retail`）注入。

`POST /api/chat/[project_id]/messages` 同样只接受 `content`、`role`、`messageType`、`conversationId`、`cliSource`；`DELETE` 只接受 `conversationId` 查询参数。消息、SSE 和 WebSocket 输出均使用 camelCase。客户端如果仍发送 `request_id`、`selected_model`、`quantCapabilityId`、`quantCapabilitySource`、`base64_data`、`public_url` 或 `conversation_id`，应修复调用方，而不是给服务端增加兼容分支。

`POST /api/projects` 只接受 `projectId`、`name`、`initialPrompt`、`selectedModel`、`description`、`agentProfileId`、通用 `capabilityId` 和 `capabilitySelectionSource`。Profile Catalog 负责解析 capability 并调用对应 workspace adapter，项目 API 不直接读取能力目录。项目模型偏好通过 `PUT /api/projects/[project_id]` 的 `selectedModel` 更新；旧 `/api/chat/[project_id]/cli-preference` 平行入口已删除。

### 零售控制台

`GET /api/v1/commerce/analytics/{overview|trend|rfm|channel-campaign|profit|inventory|lifecycle|price-elasticity|drilldown}`
提供 P28 经营分析数据；`/analytics-workbench` 将这些结果组织成总览、分群、渠道、利润、库存、商品阶段、价格带和下钻视图。`trend` 支持沿商品、类目、渠道或活动范围刷新日趋势；价格弹性在缺少同一商品多价格观察时只返回价格带对比和数据缺口，不伪造弹性系数；契约登记了对照/处理组价格实验观察时，响应还会返回两组购买率差异，并明确合成实验边界。

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/commerce/query/rewrite` | `POST` | 聊天页、运行规划器 | LLM-first 经营问题改写；所有 purpose 均由所选 LLM 解析语义，并在取数前执行安全决策 |
| `/api/commerce/symbols/resolve` | `GET` | 聊天页 | 商品/类目实体解析代理，转发 commerce-data `/api/v1/commerce/resolve` |
| `/api/commerce/capabilities` | `GET` | 业务知识中心（/business-knowledge） | 零售能力和执行依赖摘要 |
| `/api/commerce/capability-center` | `GET` | 业务知识中心（/business-knowledge） | 能力、场景知识、交付契约和支撑资源 |
| `/api/commerce/briefing/daily` | `GET/POST` | 经营情报页（/operations-briefing） | 经营日报生成与查询 |
| `/api/research/reports` | `GET/POST` | 经营情报自动化 | 观察池、证据型经营日报、运行历史和推送记录；`POST` 支持 `run-daily-report` 和 `send-latest-report` |
| `/api/evals` | `GET/POST` | 评测平台 | 用例、评测集、运行队列、模拟链路和定时任务 |
| `/api/evals/runs/[runId]` | `GET` | 评测平台 | 单次评测报告详情 |
| `/api/ops/platform` | `GET` | 运行治理中心 | Worker registry/槽位/队列、基础环境、日志、健康和降级状态 |
| `/api/infrastructure/health` | `GET` | 设置/运维 | PostgreSQL、commerce-data、Redis、Loki 等组件健康 |
| `/api/infrastructure/service-catalog` | `GET` | 设置/运维 | 服务目录、Python/Node runtime、endpoint、依赖边和配置校验结果 |

`POST /api/commerce/query/rewrite` 接收 `query`、可选 `requestedCapabilityId`、`model` 和
`purpose=preview|execution`，未传时默认 `execution`；两种 purpose 都会调用用户选定的 LLM，
因此 `preview` 不再是无模型的关键词预判。聊天输入框不会在用户输入期间频繁调用 preview，正式提交后才执行改写。
LLM 负责从原文解析商品/类目实体、时间范围、分析重点和输出意图，实体候选必须携带原文字面证据；
标准实体仍由实体解析确认（Next.js 代理 `/api/commerce/symbols/resolve` → commerce-data `/api/v1/commerce/resolve`，
支持 `item:<id>`/`cat:<id>` 显式形式与类目名/商品标题模糊匹配）。LLM 超时、未配置、网络失败或 Schema/证据不合法时返回
`llm_unavailable` 与 `QUERY_REWRITE_LLM_UNAVAILABLE`，规划和预取随即停止，不会改用关键词或正则结果继续执行。确定性"保证销量"类请求返回
`status=refused` 与 `safety.code=GUARANTEED_SALES_REQUEST`，不会进入取数或 Agent 执行。

### Skills、设置和集成

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/skills` | `GET/POST` | Skills 管理 | skill 列表、文件读取、保存、发布和回滚 |
| `/api/skills/[skillId]/package` | `GET` | Skills 管理 | 下载 skill 包 |
| `/api/settings` | `GET/POST` | 设置弹窗 | 平台设置聚合入口 |
| `/api/settings/global` | `GET/POST` | 设置弹窗 | 全局设置 |
| `/api/settings/cli-status` | `GET` | 设置/聊天页 | CLI 可用性和模型注册 |
| `/api/env/[project_id]/*` | `GET/POST/DELETE` | 项目设置 | 项目环境变量读取、upsert、冲突检查 |
| `/api/tokens`、`/api/tokens/[...segments]` | `GET/POST/DELETE` | 设置弹窗 | 服务 token 管理 |
| `/api/github/*`、`/api/vercel/*`、`/api/supabase/*` | `GET/POST` | 集成弹窗 | 外部平台连接和项目创建 |

环境变量写入只接受 `key`、`value`、`scope`、`varType`、`isSecret`、`description`，响应只输出 `valuePreview`、`hasValue`、`varType`、`isSecret` 等 camelCase 字段。密钥更新只接受 `{ "value": "..." }`；未知字段和旧 `var_type/is_secret` 直接返回 `400 INVALID_ENV_REQUEST`。Secret GET 默认只返回掩码与是否有值，不返回密文或明文。

### 用户记忆

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/projects/[project_id]/memory/preferences` | `GET/POST` | 偏好管理客户端 | 列出或显式新增当前用户的 Shop Gate 偏好 |
| `/api/projects/[project_id]/memory/preferences/[record_id]/corrections` | `POST` | 偏好管理客户端 | 追加不可变纠正 revision |
| `/api/projects/[project_id]/memory/preferences/[record_id]/revisions` | `GET` | 偏好管理客户端 | 查看 revision 历史 |
| `/api/projects/[project_id]/memory/uses/[request_id]` | `GET` | 审计/反馈入口 | 查询本轮实际暴露的 revision 与内容哈希 |
| `/api/projects/[project_id]/memory/outcomes` | `POST` | 显式用户反馈 | 对本轮真实使用过的 revision 记录可归因结果 |

聊天 `/api/chat/[project_id]/act` 会在 Agent 执行前自动调用 Memory 的 `/v1/recall` 和 `/v1/recall-contexts`。浏览器不直接提交 tenant/subject；Shop Gate 在项目授权后使用可信 `actorUserId` 构造 Scope，并再次执行产品、项目、键和长度过滤。完整配置、请求示例、效果状态与安全边界见[用户记忆服务接入、使用与效果验证](user-memory-integration.md)。

### 认证、权限、配额与用户治理

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/auth/*` | Better Auth methods | 登录页、用户菜单 | 登录、退出和数据库会话合同 |
| `/api/account/password` | `POST` | 账户安全 | 校验当前密码、修改密码、解除首次改密限制并撤销其他会话 |
| `/api/account/sessions` | `GET/DELETE` | 账户安全 | 查看不含 token 的设备摘要，撤销单个或其他全部会话 |
| `/api/account/usage` | `GET` | 账户用量 | 当前用户的有效 capability、权限来源、配额窗口及 `used/reserved/remaining` |
| `/api/admin/users` | `GET/POST/PATCH` | 用户管理 | 查询/创建用户、角色与状态治理、重置密码和撤销会话 |
| `/api/admin/access-control` | `GET` | 权限与配额管理 | capability 目录、权限模板、配额模板和规则；仅管理员可读 |
| `/api/admin/users/[user_id]/access` | `GET/PATCH` | 权限与配额管理 | 查看用户有效策略/用量；使用新鲜管理员会话更新模板和用户覆盖 |
| `/api/admin/audit` | `GET` | 用户管理 | 分页读取脱敏安全审计事件 |

认证启用后，Next.js 代理层对页面、API 和 WebSocket 执行统一的登录与早期授权检查，具体 route/service 对敏感操作再次执行权威校验。项目范围的有效权限是“账号 capability 与 `owner/editor/viewer` 项目角色的交集”；只有一层允许仍会拒绝。不存在或无权访问的项目统一返回 `404`，减少项目 ID 枚举。平台 `admin` 固定拥有全部 capability 和无限用户级配额，但已接入操作仍记录实际用量。

`PATCH /api/admin/users/[user_id]/access` 请求体支持 `permissionProfileId`、`quotaProfileId`、`permissionOverrides` 和 `quotaOverrides`。它必须同时提供 3-500 字的 `reason` 与最近一次读取的 `expectedAccessVersion`；成功后 `accessVersion` 加一并写入 `admin.access_policy_updated` 审计。版本已变化时返回 `409 ACCESS_POLICY_VERSION_CONFLICT`，未知 capability/metric 或不存在的模板返回 `400`，不能通过该接口限制管理员。传入某类 override 数组表示整体替换该类覆盖；省略则保持不变。配额 `limit/used/reserved/remaining` 是 `BIGINT`，JSON 中使用十进制字符串。

默认权限模板为 `member-default`，只读模板为 `readonly-default`。普通用户会合并有效用户覆盖与分配模板（未分配时使用默认模板）：任何有效 `deny` 优先，无 `deny` 时至少一个 `allow` 才会放行；项目 capability 还要与项目角色取交集。完整 capability 目录、模板边界和 scope 见[用户、权限与会话管理](authentication.md#capability-与项目角色)。

配额支持 `observe/warn/hard`：前两者允许执行并保留是否超额的状态，`hard` 会在请求接纳或 Worker claim 前原子检查。计量型资源使用 `used + reserved + requested`；`agent.pending` 和 `agent.concurrent` 在锁住 actor 后分别统计待执行 UserRequest/Job 与 running Job。硬配额不足时接口返回 `429 QUOTA_EXCEEDED`，响应包含 metric 和剩余额度。计量型 reservation 与用量事件都使用唯一幂等键，重复相同操作不会二次扣量。

默认成员配额共 9 项：`projects.owned=10 hard/lifetime`、`agent.pending=4 hard/lifetime`、`agent.concurrent=2 hard/lifetime`、`agent.requests.daily=100 hard/day`、`llm.total_tokens.monthly=2000000 warn/month`、`commerce.query_rewrite.llm.daily=200 hard/day`、`commerce.data_units.daily=2000 warn/day`、`operations.brief_runs.daily=20 hard/day`、`operations.brief_sends.daily=10 hard/day`。Token 与数据单元只能在结果产生后结算，因此超额时告警而不丢弃已完成结果；请求前可判断的次数执行硬限制。管理员的限额和 `remaining` 为 `null`（表示无限），但结构状态和实际用量仍按 actor 展示。

启用认证时，聊天入口把当前用户写入 `user_requests.actor_user_id`，物理 Agent run 继承为 `agent_runs.actor_user_id`，后续用量事件关联 actor、project 和 source。相同 request ID 不能跨用户或跨项目复用。LLM 问题改写的确定性 `preview` 不消费 `commerce.query_rewrite.llm.daily`；只有 execution 实际进入模型链路时才计该指标和模型 Token。

## commerce-data 数据服务 API

该服务只挂载零售 commerce 路由 + `/health` + `/ready`；不提供股票行情、回测或其他金融域端点。

### 健康与零售数据端点

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/health` | `GET` | 进程存活检查，不探测下游依赖 |
| `/ready` | `GET` | 数据库与 Redis 就绪检查；required 依赖失败返回 503 |
| `/api/v1/commerce/meta` | `GET` | 数据集口径：窗口、规模与真实/合成来源计数；传 `dataset_id` 时返回指定扩展数据集 |
| `/api/v1/commerce/datasets` | `GET` | 扩展经营分析数据集契约；可用 `dataset_id` 过滤，返回版本、生成规则、合成字段和限制 |
| `/api/v1/commerce/datasets/import` | `POST` | 受控生成隔离的合成经营分析数据集，异步执行质量扫描并返回任务 ID |
| `/api/v1/commerce/datasets/import/csv` | `POST` | 上传标准五列行为事件 CSV，保留行为来源并异步补齐合成经营分析字段；`dataset_id`、`seed`、`filename` 使用查询参数 |
| `/api/v1/commerce/datasets/import/{job_id}` | `GET` | 查询数据集导入或自动生成看板配置任务的状态、进度、结果和失败原因 |
| `/api/v1/commerce/datasets/import` | `GET` | 列出最近的数据集生成任务，支持按 `dataset_id` 和 `limit` 过滤 |
| `/api/v1/commerce/resolve` | `GET` | 实体解析：`item:<id>`/`cat:<id>` 显式形式 + 类目名/商品标题模糊匹配，`limit` ≤50 |
| `/api/v1/commerce/capabilities` | `GET` | 零售能力发现信息（domain_pack=`retail.core`，含 synthetic_fields 清单） |
| `/api/v1/commerce/funnel` | `GET` | 流量漏斗（pv/fav/cart/buy），支持 `start`/`end`/`category_id` |
| `/api/v1/commerce/funnel/daily` | `GET` | 按日漏斗趋势，参数同 `/funnel` |
| `/api/v1/commerce/categories/top` | `GET` | 类目经营榜：`metric`（默认 gmv）+ `limit`（≤100） |
| `/api/v1/commerce/items` | `GET` | 商品池分页：`page`/`page_size`（≤100）/`category_id`/`sort`（gmv\|pv\|buy\|price） |
| `/api/v1/commerce/items/{item_id}/daily` | `GET` | 单商品日粒度行为与 GMV |
| `/api/v1/commerce/inventory-risk` | `GET` | 库存风险（`limit` ≤200；合成字段 price/stock），并返回覆盖全量商品的 `health` 汇总 |
| `/api/v1/commerce/channels` | `GET` | 店铺 tier 三档（standard/premium/flagship）聚合，gmv_share ≈ 0.35/0.34/0.32 |
| `/api/v1/commerce/summary` | `GET` | 单日经营汇总，`date` 参数 |
| `/api/v1/commerce/analytics/overview` | `GET` | 扩展数据集经营概览和最近质量扫描结果，必填 `dataset_id` |
| `/api/v1/commerce/analytics/trend` | `GET` | 数据集日趋势；可选 `dimension` + `value` 按商品、类目、渠道或活动筛选，必填 `dataset_id` |
| `/api/v1/commerce/analytics/item-behavior` | `GET` | 数据集内商品级页面浏览、收藏、加购、购买和购买转化，必填 `dataset_id` |
| `/api/v1/commerce/analytics/rfm` | `GET` | 用户 RFM 分群和示例用户，必填 `dataset_id`，`limit` ≤100 |
| `/api/v1/commerce/analytics/channel-campaign` | `GET` | 渠道/活动的会话、用户、订单和订单转化，必填 `dataset_id` |
| `/api/v1/commerce/analytics/profit` | `GET` | 合成成本下的销售额、退款、成本、毛利和毛利率，必填 `dataset_id` |
| `/api/v1/commerce/analytics/inventory` | `GET` | 库存结存、平均日销量、可售天数和健康标签，必填 `dataset_id`，`limit` ≤100 |
| `/api/v1/commerce/analytics/lifecycle` | `GET` | 按窗口内首购/最近购买/活跃天数判断商品经营阶段，必填 `dataset_id`，`limit` ≤100 |
| `/api/v1/commerce/analytics/price-elasticity` | `GET` | 价格带和成交价格关系参考；有显式实验分组时返回购买率差异，缺少对应样本时返回数据缺口说明 |

关键数据：

- `/meta`：first_event_ts=2017-11-25T00:00:00Z、last_event_ts=2017-12-03T16:00:06Z、user_count=10000、behavior_source=tianchi_userbehavior
- `/items`：total 取当前主数据快照；合成兜底重建时与当前行为流商品集合对齐
- `/summary?date=2017-12-03`：GMV ¥1,198,069.97、曝光 110,710、购买 2,452、转化 2.21%、客单价 ¥488.61

窗口约定：日期参数缺省时后端默认 `end=今天`、`start=end 往前 8 天`；实际取数应由调用方显式传入数据窗口（生成管线的预取窗口动态取自 `/meta`）。`start` 晚于 `end` 返回 400。

## 常见排查路径

| 现象 | 先查 API | 再查数据 |
| --- | --- | --- |
| 商品池首屏慢 | `/api/v1/commerce/items` | 是否服务端分页、`page_size` 是否超限（≤100） |
| 漏斗数字为 0 | `/api/v1/commerce/funnel` | `commerce.user_behavior_events` 是否已导入，窗口是否落在 2017-11-25 ~ 2017-12-03 |
| 单商品无日趋势 | `/api/v1/commerce/items/{item_id}/daily` | `commerce.daily_item_metrics` 是否已跑 `aggregate-daily` |
| 金额对不上 | `/api/v1/commerce/summary` | `gmv = buy × 合成价格`，确认合成口径与 `items.price` |
| 生成页面验证失败 | `/api/chat/[project_id]/act` | `.data-agent/retail-query-rewrite.json`、`.data-agent/retail-run-plan.json`、`.data-agent/validation.json`、`data_file/final/dashboard-data.json` |
| 评测队列卡住 | `/api/evals` | `eval_queue_items`、`tmp/shopgate-eval-queue/` |

## 维护规则

- 新增页面入口时，同步补充本文件中的调用方和责任。
- 新增 commerce-data 端点时，同步更新 `services/commerce-data/README.md`。
- 改变字段口径时，同步更新 [数据字典](data-dictionary.md)。
- 新增长任务时，必须说明是否写 `commerce.platform_jobs` 或专用任务表，以及暂停、继续、停止语义。
