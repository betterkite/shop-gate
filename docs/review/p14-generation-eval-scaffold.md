# ISSUE-P14：generation/eval/scaffold 内部历史命名与模板语义零售化

## 本切片：generation、eval 与 scaffold 收敛

本 issue 的起点是 generation/eval/scaffold 中仍残留平台历史命名、金融脚手架和旧评测夹具；现已收敛为零售/电商生成与验收链路。

已完成：

- `QuantVisual*`、`QuantSurface*` 类型统一改为 `RetailVisual*`、`RetailSurface*`；
- `validateQuantVisualPresentation`、`readQuantVisualValidationReport`、`assessFinancialWorkbenchSurface` 改为零售语义；
- generation、retail validation、观测和测试调用方同步更新；
- 卡片网格诊断改为“电商经营看板 / 连续分析画布”的用户可读文案。
- generation-validation、mission control、chat 状态、skills registry 和 API 测试中的其余 `Quant*` 平台内部类型已统一为零售/电商命名；
- 删除未被运行链路引用的金融基础模板、比较模板、持仓模板和 fundamental snapshot 模板；脚手架只保留零售 base、漏斗、类目结构、价格库存、经营日报模板；
- 脚手架模板构建校验从旧金融模板切换到 5 个零售模板；旧 benchmark 测试夹具删除，workspace/artifact/e2e mapper 夹具改为零售合同；
- visual validation 的指标选择器、领域语义和诊断文案切换为商品、库存、流量、购买和转化语义；旧 guard 中的 Quant 字段匹配改为当前 commerce 兼容字段。

技能 body/scripts 中仍有少量面向金融研究的历史计算逻辑，属于 ISSUE-P8/P9 已登记的功能级技能重写，不再由本 issue 的 generation/eval/scaffold 清理重复处理。

## 本切片验收

- 视觉验收单测：15 passed；
- 本轮定向回归：9 个测试文件、96 个测试通过；
- `type-check`、`check:skills`、`check:docs`、`check:module-boundaries` 和 5 个零售模板真实 Next build 全部通过。
