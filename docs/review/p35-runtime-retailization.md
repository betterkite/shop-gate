# P35 运行时兼容合同与旧语义收敛

## 目标

清理本项目在活动运行代码、评估台、生成提示、安全沙箱和测试夹具中的无关行业语义，使公开仓库只呈现 Shop Gate 电商 Agent 的商品、类目、流量、购买、库存和经营分析能力。

本阶段不修改追加式 migration 的历史内容，也不把“禁止旧输出”的负向安全断言误判为产品残留。

## 已完成

- 评估台的 `expectedSymbols`、资产类型和金融产物统计改为分析对象、对象类型、趋势/利润/经营摘要/订单/商品/库存商品统计。
- 评估结果、搜索、创建用例 API 和详情页统一使用电商字段；历史评估数据不再被误展示为金融对象。
- PI Agent 生成提示改为商品/类目、价格/库存和电商看板约束；工具结果摘要不再生成金融接口、金融报表或金融指标说明。
- 删除未被活动代码引用的证券解析路由；生成项目沙箱桥接器改为 commerce 命名。
- 删除不再被质量工作流调用的旧合同数据 fixture。
- 个人记忆偏好从默认市场/研究周期调整为分析周期和经营分析证据偏好；自动调价、自动补货等执行行为继续作为不可自动记忆的边界。
- `package.json` 的 `private` 改为 `false`，使项目具备公开仓库元数据条件；`.env*`、运行产物和本机目录仍被忽略。
- Prisma 当前字段使用 `commerceScope`，通过 `@map("market_scope")` 保持既有数据库列兼容，不改历史 migration。
- 架构、评测、运维和产品文档已统一改为零售业务描述；公开技能变更记录只保留当前零售版本，避免把历史迁移过程当作当前能力展示。

## 有意保留的内容

以下内容不是 Shop Gate 产品能力，而是有实际用途的保护边界，不能删除：

1. `retail-validation.ts` 中用于拦截生成页面交易计划、金融接口、mock 数据和密钥的负向 guard。
2. 后端架构检查中用于确认已删除旧模块不会被重新引入的路径/导入断言。
3. Skills registry 检查中用于确认旧 Skill 不会重新进入活动注册表的历史 ID 断言。
4. `prisma/migrations/**`、历史 SQL 和数据库映射中的追加式历史字段。当前代码通过兼容映射读取，不能重写已执行 migration。
5. `.pi/skills.changelog.json` 中当前版本的发布记录。该文件由技能管理页读取并参与 `check:skills`，只保留每个已登记核心 skill 的当前零售版本。

这些内容均被测试或门禁实际引用；不属于未引用的旧产品文件。

## 验证记录

已通过：

- `npm run type-check`
- `npm run lint -- --quiet`
- `uv run --project services/commerce-data ruff check src tests`
- 受影响的 19 个 Vitest 文件：175 passed，2 skipped
- `node scripts/checks/check-validation-repair.js`
- `node scripts/checks/check-validation-stale-report.js`
- `node scripts/checks/check-generated-artifact-policy.js`
- `node scripts/checks/check-backend-architecture.js`
- `node scripts/checks/check-github-workflows.js`
- `node scripts/checks/check-module-boundaries.js`
- `node scripts/checks/check-service-catalog.js`
- `node scripts/checks/check-doc-links.js`

本轮新增的文档/示例清理还通过了旧语义主动扫描；扫描结果只保留上述负向 guard、兼容迁移键和测试断言。

## 发布前结论

最终 `npm run release:check:full` 已通过，P35 可以关闭并进入开源仓库创建前的提交整理。P28、P30、P31、P32 仍是功能路线中的开放 issue，不因本次命名清理自动关闭。
