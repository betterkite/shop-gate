# ISSUE-P26：task E2E 默认登录凭据与本地认证默认值不一致

## 问题

task E2E 脚本在没有传入专用环境变量时使用 `admin/admin`，而 Shop Gate 本地登录页和认证初始化使用 `admin@shopgate.local / shopgate2025`。这会让本地 E2E 在登录跳转阶段超时，误判为 Agent 或生成链路故障。

## 处理

- `SHOPGATE_TASK_E2E_ADMIN_LOGIN/PASSWORD` 仍然具有最高优先级。
- 未配置专用 E2E 凭据时，回退读取 `SHOPGATE_AUTH_ADMIN_EMAIL/PASSWORD`。
- 两者都没有配置时，仅对 loopback 地址使用本地登录页默认值。
- 非 loopback 地址必须完整配置登录凭据，避免误用开发默认值。

## 验收

- 使用项目实际本地认证配置运行零售 R01：`ready=1/1`。
- 预览 HTTP 200，generation、validation、dashboard-data、sources、dashboard-page 检查全部通过。
- 测试项目已自动清理。
