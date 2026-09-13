# P34 开源发布卫生与可复现性

## 范围

本切片处理公开仓库中会直接影响使用者或运行时的内容：活动 Skill、Skill registry/capsule/lock/包快照、公开启动文档、产品元数据、贡献与安全入口，以及个人绝对路径。

历史来源说明、追加式数据库 migration 和仍被兼容测试使用的旧合同不在本切片内批量删除；它们已登记到 ISSUE-P35，后续逐项判断是否属于保留的迁移边界。

## 已完成改动

- 将 `dashboard-visualization`、`run-planner`、`image-extraction`、`data-quality`、`query-rewrite` 和 `platform-ui-product-design` 的活动说明改为零售经营语义。
- 将看板校验器改为检查 `dataset_id`、经营数据区、组件覆盖和敏感值；将意图澄清脚本改为商品/类目/渠道/活动/用户范围。
- 将图片证据合同从旧持仓命名改为 `catalog-image-contract.md`，并同步编译器测试引用。
- 同步 Skill 版本、changelog、registry、runtime capsule、lock、tgz 和不可变版本快照。
- 删除公开文档中的个人绝对路径；修正 README 中的旧经营域描述和产品元数据；移除旧仓库链接，待新仓库创建后绑定最终 URL。
- 新增 `CONTRIBUTING.md`、`SECURITY.md` 和 `CODE_OF_CONDUCT.md`。

## 验收记录

- `npm run package:skills -- run-planner query-rewrite image-extraction data-quality platform-ui-product-design dashboard-visualization`：通过。
- `npm run check:skills -- --check-lock`：通过，12 个核心 Skill、14 个脚本。
- `npm run check:docs`：通过，59 个 Markdown、212 个本地链接。
- `git diff --check`：通过。
- 活动 Skill 与 runtime capsule 扫描：不再命中旧金融说明或旧图片合同名。

## 发布前剩余门

1. ISSUE-P33：生产依赖安全审计仍未通过。
2. ISSUE-P35：运行时兼容合同、验证 guard、历史权限值和测试 fixture 需要逐项清理或明确 allowlist。
3. 新 GitHub 仓库名称、可见性和最终远程 URL 尚未确认，当前仓库没有 remote。
4. 在新仓库创建后，需按 RepoSteward 规则以受审查的功能分支推送并创建 Draft PR，不直接推送 `main`。
