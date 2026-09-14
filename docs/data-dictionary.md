# 数据字典

这份文档记录 Shop Gate 当前最重要的数据表、字段口径和使用边界。它的目标不是替代 SQL，而是让前端、后端、skills 和评测在同一套事实上工作。

## 存储分层

| 层 | 存储 | 典型表/目录 | 说明 |
| --- | --- | --- | --- |
| 主业务状态 | PostgreSQL public schema | Prisma models | 项目、消息、设置、token、评测、观察池与经营日报 |
| 零售事实库 | PostgreSQL/TimescaleDB `commerce` schema | `user_behavior_events`、`items`、`daily_item_metrics` 等 | 行为事件、商品/类目主数据、日聚合、导入任务与质量扫描 |
| 短期缓存 | Redis | `shopgate:*` | 经营摘要等接口短 TTL 缓存，不作为事实库 |
| 生成原件 | 文件系统 | `data/projects/` | 生成工作空间源码、数据文件、证据和验证报告 |
| 临时报表 | 文件系统 / Loki | `tmp/`、Loki | 评测报告、运行日志、视觉截图和队列日志 |

## 零售事实库总览

唯一事实库是 `commerce.*`（PostgreSQL/TimescaleDB :5432/shopgate）。数据来自天池淘宝 UserBehavior（dataset 649）公开镜像切片，保留原始窗口 **2017-11-25 ~ 2017-12-03**（`--time-shift none`）：

- `user_behavior_events`：1,013,367 事件 / 10,000 用户 / `source='tianchi_userbehavior'`
- `items` 412,130、`categories` 5,922、`brands` 200、`shops` 500（tier: standard/premium/flagship）
- `daily_item_metrics` 687,562、`daily_category_metrics` 30,644
- 平台表：`platform_jobs`、`market_data_ingestion_jobs`、`market_data_sync_state`、`data_quality_scans`

P27 新增的 `retail-demo-expanded-v1` 是与上述 v1 事实表隔离的约 1,000 商品经营分析演示数据集：
它通过 `dataset_id` 写入 `dataset_*` 扩展表，默认包含 1,000 个商品、1,000 个用户、30 天库存快照、会话、渠道、活动和由合成 `buy` 事件派生的订单。该数据集的用户画像、渠道归因、价格折扣、成本、退款、履约状态和库存快照全部是合成数据，不能描述为真实交易或真实库存。

行为类型只有四种：`pv`(曝光) / `fav`(收藏) / `cart`(加购) / `buy`(购买)。

**合成口径**：价格/库存/品牌/店铺为合成主数据；`gmv = buy 事件数 × 合成价格`；金额处必须带"合成口径"标注。

## Prisma 主业务表

| 表 | 来源 | 责任 |
| --- | --- | --- |
| `projects` | `Project` | 首页项目、canonical workspace 路径、Profile ID/版本、Data Agent 组合 SHA-256、模型偏好、预览状态和项目 owner |
| `messages` | `Message` | 用户、助手、工具调用和错误消息 |
| `sessions` | `Session` | 旧版 Agent session 兼容记录；PI Agent 当前运行不依赖 provider session |
| `tool_usages` | `ToolUsage` | 旧版通用工具记录；包含 raw input/output，不得用于 PI Agent durable ledger |
| `user_requests` | `UserRequest` | 用户请求队列和执行状态；`actor_user_id` 记录发起账号并参与 request ID 防串用校验 |
| `agent_runs` | `AgentRun` | PI Agent 物理执行、发起账号、run/workspace 双重 fencing、usage、终态和 provenance hashes |
| `agent_workspace_leases` | `AgentWorkspaceLease` | 每个 project/canonical workspace 的跨进程独占 lease、active run 和单调 fencing token |
| `agent_generation_leases` | `AgentGenerationLease` | 每个 Project 的 planning、prefetch、Agent execution 和 validation 外层编排租约 |
| `agent_generation_jobs` | `AgentGenerationJob` | HTTP 返回前持久化的 generation envelope、attempt、dispatch lease、fencing 和终态 |
| `agent_generation_outbox_events` | `AgentGenerationOutboxEvent` | Job 生命周期的事务 outbox 与可重放投影事件 |
| `agent_worker_slots` | `AgentWorkerSlot` | 跨 Worker 进程共享的全局执行容量槽、活跃 Job、lease 和 fencing |
| `agent_worker_instances` | `AgentWorkerInstance` | Worker 进程注册、主机/PID、单进程与全局容量配置、heartbeat 和存活租约 |
| `agent_events` | `AgentEvent` | 经过安全 projector 的低频生命周期事件；源 sequence 可有间隙 |
| `agent_checkpoints` | `AgentCheckpoint` | 只用于 `replan_required` 的安全边界元数据，不保存 messages/prompt/reasoning |
| `agent_tool_executions` | `AgentToolExecution` | framework operation ID、effect/idempotency、`prepared`/`commit_authorized`/`uncertain` 状态、run/workspace fencing token 与安全 receipt |
| `agent_tool_approvals` | `AgentToolApproval` | mutating tool 在 operation prepare 前的公开输入投影、哈希、允许动作、pending/approved/edited/rejected/expired 状态和决策人；不保存原始工具参数 |
| `env_vars` | `EnvVar` | 项目环境变量，写入 workspace `.env` |
| `service_tokens` | `ServiceToken` | 外部服务 token；新写入使用 AES-256-GCM 加密，旧明文记录在读取时渐进迁移 |
| `project_service_connections` | `ProjectServiceConnection` | GitHub/Vercel/Supabase 项目连接 |
| `commits` | `Commit` | 项目关联 commit 元数据 |
| `platform_settings` | `PlatformSetting` | 平台级设置 |
| `brief_watch_pools` | `BriefWatchPool` | 经营情报观察池、市场范围、日报计划和关联推送通道 |
| `operation_brief_runs` | `OperationBriefRun` | 经营日报生成运行记录、状态、错误和证据元信息 |
| `operation_briefs` | `OperationBrief` | Markdown/JSON 经营日报、评分、建议、风险等级和 evidence |
| `notification_channels` | `NotificationChannel` | 企业微信、飞书、钉钉、Telegram、Discord、邮件等推送通道配置 |
| `notification_deliveries` | `NotificationDelivery` | 推送或 dry-run 推送记录 |
| `eval_runs` | `EvalRun` | 评测报告索引和摘要 |
| `eval_queue_items` | `EvalQueueItem` | 评测队列任务 |
| `eval_repair_tickets` | `EvalRepairTicket` | 失败修复单 |
| `eval_schedules` | `EvalSchedule` | 定时评测配置 |
| `auth_users` | `AuthUser` | 登录用户、邮箱、`admin/member` 平台角色、停用状态、首次改密和最近登录时间 |
| `auth_accounts` | `AuthAccount` | 本地 credential 账号与 Argon2id 密码哈希；不保存明文密码 |
| `auth_sessions` | `AuthSession` | 数据库登录会话、到期时间和请求设备摘要；与旧 Agent `sessions` 完全独立 |
| `auth_verifications` | `AuthVerification` | 一次性验证记录，为后续验证/重置流程预留 |
| `auth_rate_limits` | `AuthRateLimit` | 跨进程共享的认证接口限流计数 |
| `project_memberships` | `ProjectMembership` | 用户与项目的 `owner/editor/viewer` 权限；同一用户在同一项目唯一 |
| `auth_audit_events` | `AuthAuditEvent` | 登录、改密、用户治理、项目授权和权限拒绝事件；只保存安全摘要，不保存密码/token |
| `permission_profiles` | `PermissionProfile` | 可分配的账号 capability 模板；至多一个默认模板 |
| `permission_profile_grants` | `PermissionProfileGrant` | 模板中的 capability `allow/deny`；同一模板和 key 唯一 |
| `user_permission_overrides` | `UserPermissionOverride` | 用户级 capability `allow/deny`、变更原因和可选到期时间 |
| `quota_profiles` | `QuotaProfile` | 可分配的配额模板；至多一个默认模板 |
| `quota_rules` | `QuotaRule` | 模板 metric 上限、`observe/warn/hard`、窗口与 reservation TTL |
| `user_quota_overrides` | `UserQuotaOverride` | 用户级限额/无限覆盖、执行模式、窗口、原因和可选到期时间 |
| `usage_buckets` | `UsageBucket` | actor + metric + 窗口唯一的 `used/reserved` 聚合计数和并发更新版本 |
| `quota_reservations` | `QuotaReservation` | 执行前资源预留及其策略快照、TTL、结算/释放状态和幂等键 |
| `usage_events` | `UsageEvent` | 实际用量/调整的幂等事实账本，关联 actor、project、reservation、bucket 和业务 source |

Prisma 表只管理平台状态，不承载大体量行为事件和生成源码。工作空间原件仍在 `data/projects/`。

认证授权以 `projects.owner_id` 和 `project_memberships` 为项目归属事实源。owner 同时保留一条 owner membership，便于列表和审计；服务端判定时 `projects.owner_id` 优先。`auth_users.banned` 表示账号停用，`must_change_password` 会将账号限制在账户安全和退出相关入口，`password_changed_at` 与 `last_login_at` 用于管理员判断账号生命周期。`auth_sessions.token`、`auth_accounts.password` 属于敏感认证数据，任何列表 API、审计 metadata、日志和 Skills 都不得返回或记录原值。

`auth_users.permission_profile_id` 与 `quota_profile_id` 分别指向账号 capability 和配额模板；`access_version` 是非负乐观锁版本。管理员更新权限/配额时必须提交读取到的版本和变更原因，事务成功后版本加一，防止两位管理员静默覆盖。`user_*_overrides.expires_at` 为空表示长期有效，否则只在到期前参与策略解析。权限覆盖与模板合并时任何有效 `deny` 优先；项目范围 capability 还必须与 `owner/editor/viewer` 的角色规则取交集。

### 权限与配额事实模型

| 数据关系 | 不变量 |
| --- | --- |
| `permission_profiles -> permission_profile_grants` | `profile_id + permission_key` 唯一，effect 只能是 `allow/deny`；未知 capability 在应用层失败关闭 |
| `quota_profiles -> quota_rules` | `profile_id + metric` 唯一，limit 必须大于 0；window 只能是 `minute/hour/day/month/fixed/lifetime` |
| `auth_users -> user_*_overrides` | `user_id + permission_key/metric` 唯一；override 可以到期，管理员策略在应用层固定为全权限和无限配额 |
| `usage_buckets` | `actor_user_id + metric + window_start + window_end` 唯一；`used/reserved` 不得为负，版本只递增 |
| `quota_reservations` | `idempotency_key` 全局唯一；状态为 `active/settled/released/expired`，创建时保存 limit、enforcement、window 的策略快照 |
| `usage_events` | `idempotency_key` 唯一且每个 reservation 至多一个结算事件；`quantity` 可用于正向用量或受控冲正，bucket 不得下溢 |

reservation 创建时先把数量原子加入 `usage_buckets.reserved`；settlement 按实际数量减少预留、增加 `used` 并新增 `usage_events`，release/expire 只归还 `reserved`。`hard` 模式使用 `used + reserved + requested <= limit` 的条件更新防止并发超卖；`observe/warn` 允许越过阈值但保留 `exceeded` 状态。管理员和未配置 metric 的策略可无限使用，事件通过 `enforcement_exempt=true` 表示免于拦截，实际数量仍然计入 bucket 和账本。

`agent.pending` 与 `agent.concurrent` 是结构指标，不走上述 reservation 生命周期。前者统计 actor 的非终态、尚未 running 的 UserRequest/GenerationJob，后者统计 actor 的 running GenerationJob；入口和 claim 都先锁 `auth_users` 行再检查用户策略，管理 API 把实时数量投影到 `reserved` 字段，避免队列等待超过 TTL 后出现假释放。

`user_requests.actor_user_id` 在认证启用时来自当前数据库会话，`agent_runs.actor_user_id` 从绑定的 request 继承，`usage_events.actor_user_id` 再由执行或 reservation 传播。它们和业务 `source_type/source_id` 一起回答“谁在什么项目、由哪次执行产生了多少用量”。历史请求/run 可以保留空 actor，迁移不做猜测式回填；`usage_events.actor_user_id`、`project_id`、`reservation_id` 和 `bucket_id` 允许在关联对象删除后置空以保留用量事实。API 输出这些 `BIGINT` 计数时使用十进制字符串。

默认成员模板包含 9 条规则：`projects.owned=10 hard/lifetime`、`agent.pending=4 hard/lifetime`、`agent.concurrent=2 hard/lifetime`、`agent.requests.daily=100 hard/day`、`llm.total_tokens.monthly=2000000 warn/month`、`commerce.query_rewrite.llm.daily=200 hard/day`、`commerce.data_units.daily=2000 warn/day`、`operations.brief_runs.daily=20 hard/day`、`operations.brief_sends.daily=10 hard/day`。两个 Agent 结构指标由 UserRequest/GenerationJob 当前状态计算，不依赖 TTL reservation；管理员解析为无限但仍展示真实结构占用和计量用量。

PI Agent durable JSON 通过 deny-by-default 策略校验，禁止 reasoning、完整 messages、system prompt、raw provider payload、凭据和 raw cause。工具原始参数/结果只以 SHA-256、UTF-8 字节数和受控计数进入 `agent_events`/`agent_tool_executions`；`agent_tool_approvals.public_input` 与 `edited_input` 只能包含受信工具主动投影、再次通过凭据字段拒绝策略的公开 JSON。文件内容仍以工作空间为事实源。`agent_runs.workspace_key` 与 `agent_workspace_leases.workspace_key` 都是 deployment namespace 与 canonical realpath 的 `sha256:<64 hex>` 身份，不保存宿主绝对路径，也不等同于会随内容变化的 `workspace_hash`。`agent_runs.workspace_key` 没有数据库默认值，调用方必须显式提供；数据库 check constraint 和启动 readiness 会拒绝格式漂移。

## 经营分析扩展数据集

### `commerce.dataset_contracts`

每个扩展数据集一行契约，记录 `dataset_id`、版本、来源类型、时间窗口、生成种子、行数、合成字段、生成规则和限制。Agent 在使用扩展数据前必须先读取该契约；如果问题要求真实利润、真实库存或真实活动归因，而契约标记为合成，必须明确说明限制。

### `commerce.dataset_*`

| 表 | 用途 | 关键边界 |
| --- | --- | --- |
| `dataset_user_profiles` | 年龄段、性别、城市层级、会员等级 | 用户画像为合成，不代表真实用户画像 |
| `dataset_sessions` | 会话起止、渠道、活动归因 | 渠道和活动为确定性模拟，不是平台回传 |
| `dataset_channels` / `dataset_campaigns` | 渠道与活动维度 | 只用于经营分析演示 |
| `dataset_item_economics` | 标价、成本、折扣 | 成本和折扣为合成，不等于财务成本 |
| `dataset_orders` | 订单、成交价、退款、履约状态 | 由合成行为派生，不能用于收入确认 |
| `dataset_inventory_snapshots` | 商品日库存、入库、销售、预留、结存 | 无真实仓库流水，不能单独下补货结论 |
| `dataset_price_experiment_observations` | 价格实验的对照/处理组、价格、曝光人数、购买人数和分组方式 | 合成实验只能展示购买率差异参考；没有真实分组证据时不能解释为因果结论 |

这些表都带 `dataset_id`、`source`、`synthetic`。导入命令和重跑语义见 [commerce-data 接入说明](commerce-data-ingestion.md) 的扩展数据集章节。

## 零售行为与日聚合表

### `commerce.user_behavior_events`

真实用户行为事件流（天池 UserBehavior 抽样导入）。口径是事件级流水：某用户在某时刻对某商品发生某类行为。

| 字段 | 类型/口径 | 来源 | 使用位置 |
| --- | --- | --- | --- |
| `event_id` | 自增主键 | 导入 | 溯源 |
| `user_id` | 用户 ID（真实行为流） | 数据集 | 漏斗、去重用户数 |
| `item_id` | 商品 ID（真实行为流） | 数据集 | 商品池、单商品趋势 |
| `category_id` | 类目 ID（真实行为流） | 数据集 | 类目榜、类目漏斗 |
| `behavior_type` | 只允许 `pv`/`fav`/`cart`/`buy` | 数据集 | 漏斗、转化、日聚合 |
| `event_ts` | 事件时间（Unix 秒导入为 TIMESTAMPTZ） | 数据集 | 窗口过滤、趋势 |
| `source` | 固定 `tianchi_userbehavior` | 导入 | 数据溯源 |
| `imported_at` | 导入时间 | 导入 | 排查 |

本表仅存行为事实，不含金额；金额口径见 `commerce.items` 与日聚合表。不要用空值或 0 假装字段已采集，缺失时应在页面和 `data_quality_scans` 中说明缺口。

### `commerce.daily_item_metrics`

商品×日聚合（导入后由 `aggregate-daily` 生成）。

| 字段 | 口径 |
| --- | --- |
| `stat_date` + `item_id` | 联合主键 |
| `category_id` | 商品所属类目 |
| `pv`/`fav`/`cart`/`buy` | 当日四类行为事件计数 |
| `gmv` | 当日成交额 = `buy` 事件数 × 当日 `items.price`（合成静态价格） |

`gmv` 依赖合成价格，展示必须带"合成口径"标注。

### `commerce.daily_category_metrics`

类目×日聚合。

| 字段 | 口径 |
| --- | --- |
| `stat_date` + `category_id` | 联合主键 |
| `pv`/`fav`/`cart`/`buy` | 当日四类行为事件计数 |
| `buyers` | 当日去重购买用户数（人均口径基础） |
| `gmv` | 当日类目成交额（合成口径） |

客单价口径 = `gmv / buy`（件单价）。

## 商品主数据

### `commerce.items`

商品（SKU）主数据。`item_id`/`category_id` 继承真实行为流；档案字段为合成主数据（`synthetic_master=true`）。

| 字段 | 口径 | 说明 |
| --- | --- | --- |
| `item_id` | 真实商品 ID | 主键 |
| `category_id` | 真实类目 ID | 类目结构分析 |
| `title` | 合成商品标题 | 页面主显示 |
| `brand_id` / `shop_id` | 合成品牌/店铺引用 | 品牌与渠道维度 |
| `price` | 合成价格（≥ 0） | GMV 口径输入 |
| `stock` | 合成库存（≥ 0） | 库存风险 |
| `listed_at` | 上架时间（合成） | 商品结构 |

## 库存健康汇总（API 读模型）

`GET /api/v1/commerce/inventory-risk` 返回两部分：`items` 是按库销比降序排列的风险 Top N；`health` 是覆盖全量商品的汇总，不能用 `items` 样本替代。

| 字段 | 口径 |
| --- | --- |
| `total_items` | 当前商品主数据快照中的商品数 |
| `in_stock_items` | `stock > 0` 的商品数 |
| `moving_items` | 有库存且窗口内购买量 `sold > 0` 的商品数 |
| `stagnant_items` | 有库存且窗口内 `sold = 0` 的商品数 |
| `out_of_stock_items` | `stock = 0` 的商品数 |
| `moving_share` | `moving_items / in_stock_items`；无有库存商品时为 0 |

“动销占比”在看板中使用 `moving_share`，不使用库销比风险 Top N 的样本比例。
| `synthetic_master` | 固定 `true` | 合成口径标注 |

### `commerce.categories` / `commerce.brands` / `commerce.shops`

- `categories`：`category_id` 为真实行为流中的类目 ID；`name` 为合成映射（`synthetic_name=true`）；`parent_id` 支持层级。
- `brands`：合成品牌池（约 200），`synthetic=true`。
- `shops`：合成店铺池（约 500），`tier` 分 `standard`/`premium`/`flagship`，对应渠道三档聚合。

品牌/店铺归属仅用于演示分析，不代表真实品牌。商品池/品类池页面不设独立"池定义表"：商品池和类目榜由 commerce-data 的 `/items`、`/categories/top` 端点实时分页聚合（见 [API 总览](api-reference.md)）；经营情报的观察池是平台状态（Prisma `brief_watch_pools`），不属于事实库。

## 数据导入与平台任务表

| 表/视图 | 责任 |
| --- | --- |
| `commerce.market_data_ingestion_jobs` | 数据导入任务，记录 provider、范围、状态、进度、错误和统计 |
| `commerce.market_data_sync_state` | 数据源同步水位，记录 first/last ts、行数、最近成功和错误 |
| `commerce.data_quality_scans` | 数据质量扫描摘要和 issue |
| `commerce.platform_jobs` | 通用平台任务表；经营分析任务额外记录 `project_id` 和 `idempotency_key` |
| `commerce.analytics_orchestration_events` | 导入/看板编排 durable outbox；按项目、任务和顺序记录请求、清单就绪、完成/失败事件，`consumed_at` 记录消费者确认 |

导入通过 `shopgate-commerce-import` CLI 驱动（`import-userbehavior`、`generate-synthetic-behavior`、`generate-synthetic-master`、`aggregate-daily`，见 [commerce-data 数据接入](commerce-data-ingestion.md)），provider 书签写入 `market_data_ingestion_jobs` / `market_data_sync_state`。任务失败或停止不删除已入库事实数据。

当前零售域不设独立的回测表；“规则验证”由生成管线内的自动验证承接（build/HTTP 200/数据文件/evidence/产物契约/图表/entity-scope/视觉），结果写入生成工作空间的 `.data-agent/validation.json`。

## 基础组件表

| 表 | 责任 | 页面 |
| --- | --- | --- |
| `commerce.data_quality_scans` | 数据质量扫描摘要和 issue | 运行治理 |
| `commerce.platform_jobs` | 通用平台任务表，经营分析任务按项目和幂等键隔离 | 运行治理/平台任务 |
| `commerce.analytics_orchestration_events` | 分析跨服务事件 outbox 和消费确认 | Agent 编排/运行治理 |

## 当前核心经营指标

| 指标 | 口径 | 主要来源 | 说明 |
| --- | --- | --- | --- |
| `pv`/`fav`/`cart`/`buy` | 四类行为事件计数 | `user_behavior_events`、`daily_*_metrics` | 零售行为分析的基础 |
| `gmv` | `buy` 事件数 × 合成价格 | `daily_item_metrics.gmv`、`daily_category_metrics.gmv` | 金额必须带"合成口径"标注 |
| 转化率 | `buy / pv` | `/api/v1/commerce/summary` | 示例：2017-12-03 为 2.21% |
| 客单价 | `gmv / buy`（件单价） | `daily_category_metrics`、`/summary` | 示例：¥488.61（2017-12-03） |
| `price`/`stock` | 商品合成主数据 | `commerce.items` | 展示必须带合成口径标注 |
| 库存/售罄风险 | 价格、库存与近期销量对比 | `/api/v1/commerce/inventory-risk` | 合成字段：`price`、`stock` |

指标解释不散落在代码里；口径变更必须回到本文件与 `sqls/` 同步。

## 数据质量口径

| 检查 | 判定 |
| --- | --- |
| 事件窗口 | first/last event ts 与原始窗口 2017-11-25 ~ 2017-12-03 对齐（`--time-shift none`） |
| 行为枚举 | `behavior_type` 只允许 `pv/fav/cart/buy`，其他取值视为脏数据 |
| 字段完整 | 聚合表 `pv/fav/cart/buy/gmv` 非空且不为负 |
| 合成口径 | `price/stock/brand/shop` 与金额展示必须带"合成口径"标注，`gmv = buy × 合成价格` |
| 主数据一致 | `items.category_id` 必须能解析到 `categories`；孤儿引用视为导入缺陷 |

## 维护规则

- 新增 SQL 表或字段后，同步更新本文件和 `sqls/README.md`。
- 新增数据接入契约或导入命令后，同步更新 `docs/commerce-data-ingestion.md`。
- 页面新增指标时，必须能在本文件找到来源和口径。
- 缓存字段不能作为长期事实；会影响经营结论或看板生成的结果必须落库或写入 evidence。
