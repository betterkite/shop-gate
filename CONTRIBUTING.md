# 参与贡献

感谢参与 Shop Gate。项目是面向零售经营分析的开源 Agent 工作台，业务改动需要同时考虑数据口径、Agent 合同、页面交互和可验证性。

## 开始之前

1. 使用 Node.js `>=22.19.0`、npm `>=10.0.0` 和 Python/uv，运行 `npm ci`。
2. 运行 `npm run ensure:env`，只在本机 `.env.local` 中填写凭据；不要提交任何密钥、Cookie、生成数据或本地数据库文件。
3. 按 README 启动数据库和 commerce-data，再运行目标测试。

## 提交改动

- 一个 Issue 对应一个聚焦的分支和 Pull Request；不要直接提交 `main`。
- 先在 Issue 中写清用户影响、数据口径、验收条件和已知限制，再实现改动。
- 前端改动至少验证 `npm run lint`、`npm run type-check`；业务或后端改动补充对应单测、API/CLI、构建和桌面/移动验收。
- 修改 Skill 源时同步更新 registry、版本记录、锁文件和包，并运行 `npm run check:skills`。
- 页面、数据接口和 Agent 结果都必须提供真实的加载、空数据、错误和限制说明；不得用示例数据冒充真实结果。

## Pull Request 清单

- [ ] PR 关联 Issue，并说明未覆盖的范围。
- [ ] `git diff --check` 通过，未包含 `.env*`、`data/`、`tmp/`、`public/uploads/` 或个人路径。
- [ ] 相关单测、类型检查、Lint、构建和文档链接检查通过。
- [ ] 公开文案使用用户能理解的零售经营语言，指标口径和数据来源可追溯。

安全漏洞请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中披露可利用细节。
