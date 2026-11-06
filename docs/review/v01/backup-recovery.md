# 经营账本备份、恢复与重启

对应 [#87](https://github.com/betterkite/shop-gate/issues/87)。本页给出已在独立 PostgreSQL18 环境实际演练的步骤与边界；不表示日常环境已经迁移或部署。R3–R7新增的成本维护、目标操作、报表视图等仍要加入最终恢复演练。

## 备份包含什么

完整数据库备份应同时包含现有认证/工作空间表和 `bi` 事实、成本/费用快照、版本、来源、任务、预览、批次、操作与审计；不能只备份几张订单表。角色、成员关系、对象所有者、授权、RLS、触发器和函数同样需要恢复，尤其不能丢失维护函数的固定执行身份。

数据库备份含账号密码哈希、会话和私有经营数据。存放在受限目录/备份系统，按实际环境加密与保存访问记录；不放进公开仓库、工作台知识、Issue、浏览器下载目录或普通日志。角色备份排除角色密码，运行登录的凭据由原授权私有系统单独恢复。文件、配置和密钥的备份分别管理，不把模型密钥打包进经营数据集。

## 迁移前的显式目标

迁移命令只读取 `SHOPGATE_BI_MIGRATION_DATABASE_URL`，不加载 dotenv，不回退 Web 的 `DATABASE_URL` 或 API/worker 连接。独立空模板见 `deploy/bi-migration.env.example`。管理员从私有系统向进程显式提供已审核的主机、账号、数据库和 TLS 参数；不要把真实连接粘贴进命令历史或任务记录。缺失目标时命令拒绝运行。

先备份并在新目标恢复验证，再根据变更范围与授权显式运行：

```sh
uv run --project services/commerce-data python -m shopgate_commerce_data.ledger.migrations
```

当前有序迁移为006–011，事务及校验规则见[账本底座](ledger-foundation.md)。正常 Web/API/worker 启动不运行此命令，不初始化演示或覆盖经营事实。不得通过改写旧迁移、删除 schema 或清空数据“修复”校验失败。

## PostgreSQL18恢复步骤

使用与服务器兼容的官方 PostgreSQL18 客户端；应用测试所用嵌入式服务器包仅有服务器工具，不能以服务器能启动代替 `pg_dump`/`pg_restore`。运维从私有连接配置指定源 `PGHOST/PGPORT/PGUSER/PGDATABASE`；连接密码通过授权私有系统提供，不写入以下示例。`BACKUP_DIR` 为本次独立受限目录。

在暂停确认/导入/重算写入的维护窗口，确认没有正在执行的任务，保存数据集版本与核算摘要；记录 PostgreSQL版本、产品revision和迁移校验和。实际执行并检查每一步退出状态：

```sh
umask 077
pg_dumpall --roles-only --no-role-passwords --file "$BACKUP_DIR/roles.sql"
pg_dump --format custom --lock-wait-timeout 10s --file "$BACKUP_DIR/ledger.dump"
sha256sum "$BACKUP_DIR/roles.sql" "$BACKUP_DIR/ledger.dump"
```

源备份应保持不变。将恢复目标指向**单独的新集群和空数据库**，核对目标连接、目录、网络和所有者；不要直接覆盖仍在使用的数据库。工作区任务中的合成环境不使用日常数据；实际迁移/覆盖现有数据另需对应授权。

角色恢复先于对象恢复。保持原初始化管理员身份及原 `GRANTED BY` 成员授权；本次实测不同初始化管理员导致任务组成员授权被拒绝。若相同管理员已由目标 `initdb` 创建，审阅原 roles.sql，只在私有执行副本精确省去那一条预期已存在的 `CREATE ROLE`，保留该角色全部 ALTER、其他角色和全部 GRANT。保存原件/副本摘要及差异，其他错误立即停止；不使用忽略全部错误、删除授权人或扩大角色权限的办法。

以下命令的 PostgreSQL连接环境此时应明确指向新目标。`RESTORE_DATABASE` 和 `RESTORE_OWNER` 为经审阅的目标库和原所有者：

```sh
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname postgres --file "$BACKUP_DIR/roles-reviewed.sql"
createdb --owner "$RESTORE_OWNER" --template template0 --encoding UTF8 "$RESTORE_DATABASE"
pg_restore --exit-on-error --single-transaction --dbname "$RESTORE_DATABASE" "$BACKUP_DIR/ledger.dump"
```

恢复不使用 `--no-owner`、`--no-privileges` 或关闭触发器代替权限恢复。不同操作系统上的 locale/collation 需要另行核对；本次合成集源/目标都是 UTF8、locale C。完成后按新目标私有配置显式重复校验006–011，不改历史checksum，不重新导入或生成源事实。

逐项核对：所有源/快照/版本/任务/批次/审计表行数和内容摘要、现有序列状态、对象所有者与实际有效权限/授权人/转授权、RLS及强制开关、函数/执行身份、触发器、迁移版本和校验和。PostgreSQL可能将显式 owner-only ACL恢复为等价默认 NULL ACL，应展开实际权限比较，而非放弃授权核对。用独立非管理员 API/worker 角色重测：未绑定范围看不到订单、正确范围返回预期金额、其他空间不可访问；不要只以管理员能查数据判定成功。

切换应用前复核原有效登录、工作空间成员和当前策略。长任务使用原记录和租约/实际进程锁恢复；不要把已提交任务重复执行或把旧会话自动升级为新授权。原始临时文件可能到期，按[保留策略](private-retention.md)明确重新导出或重新预览；不能将过期误报为数据丢失。

## 实际演练证据与限制

2026-10-26，在独有临时 Web/API/worker/PG18 中真实登录、上传CSV12并确认了固定核算集。版本1预览时正式事实0；明确确认后版本2，4个原订单/4明细/4退款，正式操作和审计各1，付款订单2。完整期间销售260元、退款96元、净销售164元、商品成本33元、费用10元、已核算贡献利润121元。

使用固定官方客户端镜像 `postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6` 实际备份，并在另一新PG18集群恢复。87张public/bi表的全部行摘要一致；41条隔离策略、22个触发器、14个BI函数、7个相关角色、1项任务组成员关系及有效权限一致。重复校验006–011后内容不变，非管理员Query仍为版本2和121元。独立记录保存于对应工作台任务，不含公开凭据。

同一个验收容器中的原数据库、Web、API、worker重启后，全部87表与权限摘要、原浏览器会话/批次/审计不变，API健康检查通过。首次专用管理脚本在子进程全部退出时结束，后续恢复又发现必须明确复用原PG端口；失败记录保留，脚本修正后仅恢复原集群，未初始化、迁移或生成新数据。它们是临时验收环境问题，不作为首次全部成功记录。

上述说明的是R2已有数据及真实备份/进程恢复。重启后的真实网页再次登录、导出与剩余页面交互仍需浏览器验收；八模块/32助手真实模型/100000订单性能及最终CI也未由此证明完成。用户日常数据库未执行迁移、清理或覆盖，没有生产部署证据。

官方运维依据：[PostgreSQL18 pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html)、[GRANT](https://www.postgresql.org/docs/18/sql-grant.html)。

## 分离迁移账号与应用账号时的助手表权限

R3四项Prisma迁移由迁移账号创建新表。若应用账号只获得原有public表权限，新表不会自动继承授权，Worker的结构检查会拒绝启动。迁移后应按部署中的应用角色，对以下六张表授予其运行所需的SELECT、INSERT、UPDATE、DELETE：`agent_execution_scopes`、`bi_agent_conversations`、`bi_agent_requests`、`bi_agent_results`、`bi_agent_result_pages`、`bi_agent_answers`。部署工具应引用实际角色标识，不拼接外部输入，不对所有角色/PUBLIC开放，不改用superuser或BYPASSRLS，不变更BI账本策略。原有表和角色权限须保持，并将具体变更列入部署审计。

先用实际应用连接完成结构检查，再确认BI Worker在线；不能仅以迁移命令成功判断服务可用。原数据库备份、旧列内容核对与恢复演练仍是升级前后必需证据。嵌入式PostgreSQL发行包不一定包含pg_dump；可使用与数据库兼容、固定版本的官方PostgreSQL客户端制作并恢复备份，格式可读不等于实际恢复通过。
