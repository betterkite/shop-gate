# R2-B 持久数据任务（候选，尚未验收）

对应 [issue #87](https://github.com/betterkite/shop-gate/issues/87)。在已验证的[签名经营接口](bi-http.md)之后，实现私有持久任务、独立worker和当前会话复核。此文描述候选代码；新测试未运行，不能据文件存在判定成功。前端导入中心与真实浏览器仍待接入，完整v0.1不缩减。

## 用户操作与持久状态

四种任务：标准文件预览、演示源事实准备、用户确认导入、标准数据导出。预览不是正式写入：原始文件私有存入PG，规范化预览仍使用回滚试算；用户确认后才按当前版本/期限/幂等写账本。演示只作用于明确确认的新空演示集，不重置原演示，更不补齐正式事实。

提交返回202和任务ID，状态存于新增010迁移的`bi.jobs`，不是进程内Map。状态包括等待、运行、等待重新授权、待确认预览、校验未通过、已提交、导出完成、失败、取消；显示安全中文阶段而非假百分比。每页20、完整数量、稳定排序，任务输入/会话ID/文件均不返回页面。原始文件与导出结果私有存于`job_files/job_outputs`，不进入public/uploads或Git。

每个数据集/账号最多3个未过期的活动任务。任务输入/摘要/版本/来源不可改写，默认一天有效，确认预览900秒有效；过期须重新提交，不能暗中更换版本继续。续授权仅用于未取消的awaiting_auth任务，使用真实当前会话、同actor与原版本；不重新解释原请求。

## 当前权限复核

Node签发`shopgate-bi-jobs-v1`，绑定真实session ID和已授权工作空间/数据集/版本/能力；不保存cookie或bearer token。该用途不能交换为目录/事实令牌。

独立worker执行开始和提交前调用精确内部路径`/api/internal/bi/job-authorization`。请求使用25秒独立用途HMAC，绑定任务ID、种类、输入摘要、actor、session、版本与start/commit阶段。proxy仅对该确切POST且正确签名放行；不是公开前缀，处理器再次验证。处理器读取真实AuthSession/AuthUser当前状态、过期/停用/强制改密/密码变更，复用权限评价器与当前项目成员关系，不构造伪会话。授权关闭模式及模拟登录不会被当作真实长期权限。返回20秒、用途和每项任务字段绑定的签名许可，worker验证后即丢弃，不持久化。

读取始终检查账号能力，共享空间需要当前成员；修改还需账号管理能力及owner/editor交集。标准导出允许只读角色。Node取消前先读取当前不可变任务种类，再确定管理能力；浏览器不能自报kind来绕过后端管理检查。权限变化时尚未提交事务回滚并显示等待重新授权。

## 原子提交、租约与取消

专用非管理员worker通过租约和会话级任务锁领取，进程退出后锁释放，租约过期可由新worker恢复。执行必须使用原领取连接，旧执行权不能覆盖新结果。长计算不锁任务行，取消可及时登记；提交前的短行锁将取消与提交排序，再核对租约/取消/当前授权。提交先发生则返回已提交，不能伪报取消。

预览/正式导入的完成回调在原账本事务中更新任务终态；源事实、核算、版本、审计与committed一起提交，崩溃不能留下“写入成功但任务待重试”而重复增版本。回调失败全部回滚。预览新增全源范围before/after试算，调用同一Query计算服务，金额仍为十进制字符串、未知null；不是另写一套前端公式。试算更新也在强制回滚savepoint中，不产生真实经营版本。

标准导出先读取同一只读版本，再经当前授权复核将完整文件及摘要、原版本和任务完成状态原子保存。下载需要当前用户/工作空间/数据集权限，且只能拿自己任务的已准备资源；错误文件使用已有公式保护与不回显源单元格策略。清理私有过期原始/导出大文件仍需后续有明确目标和审计的维护流程，本片不自动删除事实/审计或私有文件。

## 接口与运维配置

Node同源`/api/bi/jobs`对应Python`/api/v1/bi/jobs`；GET列表、POST提交、GET `/{job_id}`、POST `/{job_id}/{cancel|reauthorize}`、GET `/{job_id}/files/{resource}`。Node查询参数/提交外层使用workspace_id（可选）、dataset_id、version；Python从短效签名取身份范围。POST另含kind、parameters、idempotency_key和files（预览时需要）。files为resource、filename、content_base64；文件名仅显示，不作为文件路径。

JSON/base64入口严格按80MiB编码体积+64KiB元信息限额逐块计量，解码后仍执行单文件20MiB/整批60MiB/36文件/100000行/字段3000字符限制，不能利用编码膨胀绕过。小指令仍64KiB。新路径不接收任意SQL、任意上游URL、浏览器actor/session、状态或服务密钥。

运维先备份和演练恢复，显式安装006–010。010创建NOLOGIN/NOSUPER/NOBYPASS的shopgate_bi_worker队列组，不自动创建可登录用户；管理员另给专用worker登录角色授组及账本表权限。队列组只增加队列数据访问，不改变事实表精确范围RLS。API仍用独立非管理员SHOPGATE_BI_DATABASE_URL，worker显式SHOPGATE_BI_WORKER_DATABASE_URL，无管理员DSN兜底。双方相同SHOPGATE_BI_SERVICE_SECRET，worker固定SHOPGATE_BI_AUTH_ORIGIN为Web服务源。演示受SHOPGATE_BI_DEMO_ENABLED显式开关。

独立入口`uv run --project services/commerce-data shopgate-bi-worker`，`--once`处理一个持久任务；systemd样本为`deploy/systemd/shopgate-bi-worker.service`。普通API/worker启动不迁移、不创建任务、不生成数据。此处没有启用用户服务或应用日常DB迁移，不声称生产已部署。

worker使用独立的`deploy/bi-worker.env.example`四项模板；systemd读取私有`/etc/shopgate/bi-worker.env`，不再读取Web的共享环境文件。直接运行可由服务管理器传入四项值，或显式设置`SHOPGATE_BI_WORKER_ENV_FILE`选择私有配置文件。worker不自动发现根目录`.env/.env.local`，文件不做变量替换、不能夹带管理员/模型/Node认证配置，已传入的环境值优先。复制时保持私有权限，不填写或提交真实凭据到公开模板。

## 候选验收与剩余项

新增纯协议/签名、Node真实会话读取及权限评价单元、精确proxy门、网关和真实PG任务测试。真实PG场景包括手算121元预览/确认/12导出、元信息20分页、幂等/私有输入/RLS、领取竞争、取消/提交竞争、执行与提交前拒绝授权的完整回滚、用户新会话续授权、演示正式隔离、错误下载与实际独立worker进程在领取后异常退出后的新进程恢复。

进程恢复测试的回环HTTP授权端是明确标注的服务测试替身，不能冒称真实账号/Node集成。最终还须真实页面/Node/worker/真实登录和撤销链路、完整默认演示规模长任务、取消重连、私有过期文件清理、服务重启/数据库恢复及R7性能验收。#87仍dev，不以局部任务schema/API通过当全阶段完成。
