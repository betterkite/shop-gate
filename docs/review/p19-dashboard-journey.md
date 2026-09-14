# P19 看板任务闭环验收记录

## 问题冻结

用户问题：

> 库销比最差的 10 个商品是哪些？它们的流量转化情况如何？

本轮核查确认：

- 项目 `project-1789032793896-1qu1wut06` 的 `retail-run-plan.json` 状态为 `needs_clarification`，没有 `previewUrl`，也没有 `data_file/final/dashboard-data.json`；因此本轮没有成功生成可查看看板。
- Query Rewrite 使用 `deepseek-v4-flash` 直连 DeepSeek，实际返回 HTTP 401。修复前只显示“暂时不可用”，无法区分凭据失效和模型不存在。
- 首页的“成果中心”按钮硬编码进入 `/operations-briefing`，而该页面产品名称为“经营情报”，造成入口语义与目标页不一致。
- 价库模板只展示曝光与销量，没有购买转化率，且表格展示 12 行，不符合该问题的 Top 10 口径。

## 实现范围

- 首页“成果”入口改为回到当前首页的“最近成果”区域，不再跳转经营情报页；最近成果行仍进入对应项目聊天/看板页。
- Provider 将 HTTP 401/403 归一为 `LLM_AUTH_FAILED`，HTTP 404 归一为 `LLM_MODEL_NOT_FOUND`，并在 Query Rewrite 澄清信息中给出可操作提示；仍保持失败关闭，不以关键词猜测替代模型语义。
- `inventory-risk` 增加 `buy_conversion`（购买事件 / 页面浏览量）字段；价库看板按库销比降序展示 Top 10，并显示页面浏览量（PV）、窗口销量和购买转化率（Buy / PV）。
- 看板数据合同同步要求价库行具备 `sold`、`views` 和 `buy_conversion`，避免只生成库存风险而缺少流量转化分析。

## 验收条件

- [x] Query Rewrite 的 401/403 单测通过，错误信息不再与普通不可用混淆。
- [x] 后端 `buy_conversion_rate` 单测、ruff、pytest 通过。
- [x] type-check、相关 Vitest、脚手架模板检查通过。
- [x] 模板源码包含 Top 10、页面浏览量（PV）和购买转化率（Buy / PV），无成果入口到 `/operations-briefing` 的误链。
- [x] 使用有效 DeepSeek 直连凭据重新执行该用户问题：Query Rewrite 成功识别“库销比最差 10 个商品”为全库 Top-N 范围，生成 `dashboard-data.json`、验证报告和可预览 URL；验证状态为 `READY`，预览 HTTP 200。隔离 E2E 项目已在验收后自动清理。

## 验收记录（2026-09-14）

- 公开 R15 价格/库存场景：`READY`，生成/验证/数据证据/看板页面 5 项检查全部通过，预览 HTTP 200。
- 用户原问句隔离场景：`READY`，模型为 `deepseek-v4-flash`，生成/验证/数据证据/看板页面 5 项检查全部通过，预览 HTTP 200。
- 原失败原因是 Query Rewrite 将未写出“全库/窗口内”的 Top-N 库销比排行误判为 `comparison_scope` 缺失；现已增加受限的“库存指标 + 排名方向 + Top-N 数量”全库识别，并保留模糊推荐问题的澄清行为。
- 临时 E2E 项目、失败调试项目和外部测试输入均已清理；不把测试凭据或运行产物提交到仓库。
