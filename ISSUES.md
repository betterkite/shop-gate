# Shop Gate Issue 清单

> 轻量纪律（源自 RepoSteward 工作流）：每个改动包一个分支 → 测试门通过 → 合入 `main`。
> 状态：`open` / `in-progress` / `done` / `deferred`。阶段定义见 PROVENANCE.md 与共识阶段计划。

| ID | 标题 | 阶段 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| ISSUE-P0 | 落地与地基：导入快照、构建修复、机械换牌、删 benchmarks | P0 | 5 个提交全部过测试门；`QuantPilot/quantpilot/QUANTPILOT_` grep 归零（三条例外除外）；基线已知失败记录在案 | in-progress |
| ISSUE-P1 | 零售电商 PRD：定位、非目标、4 capabilities、数据口径（真实/合成边界）、页面映射表、验收标准 | P1 | `docs/prd.md` 完成并经用户签字确认 | open |
| ISSUE-P2 | 数据切片：`commerce.*` 零售 schema、UserBehavior 抽样导入 provider、合成商品主数据、commerce-data 最小接口、prisma 追加式 migration | P2 | `db:up` → 导入成功 → 领域接口可 curl；SQL `quant.*` schema 处置完成 | open |
| ISSUE-P3 | retail Domain Pack：按 docs 七步建 `src/lib/domains/retail/`（4 capabilities），注册 + 切默认 Profile；重写 `src/lib/commerce` 21+7 领域耦合文件（含 `pi-agent-prompts.ts` 高危点）；移除 `finance.quant` 包；module-boundaries 登记 | P3 | 测试/typecheck/边界检查绿；可创建零售任务 | open |
| ISSUE-P4 | 前端切片：首页零售示例 prompt、导航与通用文案、ToolResultItem 领域渲染、商品池最小可用页、经营情报中心占位 | P4 | `npm run dev` 可用；首页/商品池无金融文案残留 | open |
| ISSUE-P5 | 最小闭环验收：自然语言零售问题 → 生成 dashboard 端到端 | P5 | 用户验收通过 | open |
| ISSUE-P6 | 商品池/品类池/渠道分析全量重建（原 strategy-platform 6,299 LOC） | P6 | 1:1 映射完成，视觉 smoke 通过 | open |
| ISSUE-P7 | 经营情报中心全量（原 research-reports 891 LOC + 日报自动化） | P7 | 日报链路可运行 | open |
| ISSUE-P8 | Skills 重写与清洗：6 个领域 skill 零售化 + 5 个通用 skill 清洗金融示例 + registry/lock/tgz/capsules 同步 | P8 | `npm run check:skills` 绿 | open |
| ISSUE-P9 | 评测与 e2e 基准重建（eval 7 文件渗漏 + benchmarks 替代方案） | P9 | 新基准可运行，依赖 benchmarks 的 skip 测试恢复 | open |
| ISSUE-P10 | docs/README 内容级重写 + 品牌终审（grep 终验） | P10 | 文档与实际一致；品牌归零复查通过 | open |
| ISSUE-P11 | （可选）`src/lib/commerce` 33 个纯平台文件物理迁移 `src/lib/generation/` | 后续 | 迁移后全部门绿 | deferred |

## P0 已知基线

- 基线门：`npm test`（vitest + pytest）、`npm run type-check`、`ruff check`。基线结果与本机环境性失败记录于 P0 阶段报告，后续阶段以"不劣于基线"为门。
- `benchmarks/` 在 P0 删除后，依赖它的测试以显式 skip + 本清单 ISSUE-P9 挂账。
