# R2-B 签名经营接口

对应 [issue #87](https://github.com/betterkite/shop-gate/issues/87)。目录、空集创建、指标/模板与统一查询957798f已通过verification:b546ffb7的368后端/0skip、真实PG18及六项+Git；不是完整导入中心或八模块页面。随后新增的[持久任务候选](bi-jobs.md)需要新的完整验证，不能借用旧证据。

## 使用边界

Python新路由`/api/v1/bi`在原commerce-data服务注册；Node同源路由`/api/bi`沿用登录、同源保护与权限目录。每个Node路由显式校验账户能力，签发器再核对真实会话、个人空间/共享项目角色和写入能力交集。浏览器不得传actor/角色/任意后端地址；令牌只在服务间使用，不发送给页面或模型。

| Node 同源路径 | Python 服务路径 | 作用域 |
| --- | --- | --- |
| GET /api/bi/datasets | GET /api/v1/bi/datasets | 工作空间元信息，只读，20/页 |
| POST /api/bi/datasets | POST /api/v1/bi/datasets | 元信息管理，明确确认、幂等键与来源 |
| GET /api/bi/catalog | GET /api/v1/bi/catalog | 元信息只读；中文指标及十二模板字段说明 |
| GET /api/bi/templates/{resource} | GET /api/v1/bi/templates/{resource} | 元信息只读；固定白名单模板下载 |
| POST /api/bi/query | POST /api/v1/bi/query | 指定数据集、版本的事实只读 |

GET可传`workspace_id`（无值则为实际账号个人空间），目录另支持page/page_size/source_kind。POST创建可传workspace_id，必须包括dataset_id/name/source_kind/idempotency_key/confirmed_by_user:true。查询是`{workspace_id?,dataset_id,version,query:{...受控Query字段}}`；无SQL或任意公式。Python只从已验签令牌取身份和数据范围，拒绝浏览器自报字段与用途混淆。元信息权限没有通配事实读取能力。

## 配置和运维

- 双方设置相同`SHOPGATE_BI_SERVICE_SECRET`，至少32字节；不使用NEXT_PUBLIC。
- Python显式设置`SHOPGATE_BI_DATABASE_URL`，连接角色必须非超级用户且NOBYPASSRLS。缺省不回退旧DATABASE_URL；不读取模型密钥。
- 仅演示环境可设置`SHOPGATE_BI_DEMO_ENABLED=1`；不影响正式空集创建。此处只创建空集，不自动生成经营记录。
- Node设置固定`SHOPGATE_COMMERCE_API_URL`服务源地址；拒绝带用户名密码、路径、查询或片段的地址，不跟随跳转。
- 运维先备份并显式安装006–009迁移及运行角色授权，参见[账本底座](ledger-foundation.md)；普通启动不迁移、不生成、不重置。尚未在用户日常数据库应用迁移。

数据库连接有连接/语句/锁等待上限；请求在工作线程内执行阻塞数据库逻辑，保持事件循环可响应。快查询/创建不是持久长任务的替代：导入预览、演示生成、标准导出、取消和重启恢复仍须下一片实现，不能用长时间挂起网页请求代替。

## 安全、版本和验收

JSON输入64KiB前后限额，拒绝压缩内容/畸形JSON/重复字段（Python）/非严格类型/额外身份字段。目录和模板只允许固定参数与资源；查询指标、维度、筛选数、日期、排序、分页受控。输出十进制字符串、未知null，与核算服务同源同版本；陈旧版本409，权限403，未就绪503，输入422，超大413。

Node不转发Cookie、浏览器Authorization或任意头部；响应不透传上游任意头/错误文本，成功负载按固定业务字段选取，校验事实范围与版本。Python异常处理不回显Pydantic原始input、SQL、连接串或私有单元格；日志仅自生成请求编号与安全分类。全部响应no-store/nosniff，CSV使用生成的安全下载文件名。Node限制响应2MiB；大导出不使用该JSON查询路径。

新增用例包括真实PG签名HTTP查询/创建/持久目录、十二模板、中文指标、与统一查询逐值比较、陈旧版本、跨空间、用途混淆、只读/确认/生产演示开关、管理员连接拒绝、无配置不兜底、输入限额、错误脱敏；Node实际签发器、权限调用、固定服务源、同源/上传限额、失败脱敏与响应范围。测试尚待运行，不以新增文件代替通过证据；前端/长作业/浏览器仍未完成，#87保持dev。
