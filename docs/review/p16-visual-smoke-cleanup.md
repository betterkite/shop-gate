# ISSUE-P16：登录态视觉 smoke 与失败预览清理

## 问题

视觉检查已经复用了登录辅助器，但缺少一个独立的登录态门禁；同时 task E2E 失败时默认保留测试项目，失败项目关联的预览进程可能继续占用端口。

## 处理

- 新增 `npm run check:visual-auth`，独立确认登录态可复用、首页未回到 `/login`、经营分析输入框可见、项目接口返回成功。
- task E2E 失败 case 自动清理对应测试项目；成功 case 的保留策略不变，显式 `--cleanup` 仍会清理整批项目。
- 视觉认证辅助器与 task E2E 统一读取项目认证配置和本地默认值。

## 验收记录

- 首页 7 种视觉布局检查通过。
- 独立 `npm run check:visual-auth` 通过：首页未回到登录页、经营分析输入框可见、项目接口返回 2xx。
- task E2E R01 在有效登录态下通过，预览 HTTP 200，临时项目已清理。
- R01–R04 连续运行证据为 4/4 READY。
- 变更后的完整 `npm run release:check` 通过：前端 `1020 passed / 29 skipped`，后端 `18 passed`，生产构建通过。
