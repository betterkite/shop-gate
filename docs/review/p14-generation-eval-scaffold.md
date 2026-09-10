# ISSUE-P14：generation/eval/scaffold 内部历史命名与模板语义零售化

## 本切片：视觉验收公共契约

`src/lib/commerce/visual-validation.ts` 仍向 generation 和 retail validation 暴露 `Quant*` 类型及 `validateQuant*` / `readQuant*` 函数，并把电商看板规则描述为金融工作台。

已完成：

- `QuantVisual*`、`QuantSurface*` 类型统一改为 `RetailVisual*`、`RetailSurface*`；
- `validateQuantVisualPresentation`、`readQuantVisualValidationReport`、`assessFinancialWorkbenchSurface` 改为零售语义；
- generation、retail validation、观测和测试调用方同步更新；
- 卡片网格诊断改为“电商经营看板 / 连续分析画布”的用户可读文案。

## 尚未完成

- generation-validation、mission control、chat 状态中的其余 `Quant*` 平台内部类型；
- scaffold 中仍保留的股票、行情、持仓和财务模板兼容层；
- eval 中历史金融 case、snapshot contract 和 financial calculation skill scripts 的零售化重写。

## 本切片验收

- 视觉验收单测：15 passed；
- `type-check`、Lint、文档链接和 scaffold 模板构建需在提交前复核。
