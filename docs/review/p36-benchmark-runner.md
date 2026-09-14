# P36 公开 Benchmark Runner 与数据集边界

## 目标

让公开的 `benchmark:commerce:e2e` 真正执行零售 task-E2E，而不是只检查旧的“已有证据”；同时让 hidden / production replay 只接受外部注入，并在可提交报告中脱敏。

## 本轮改动

- `scripts/evals/run-commerce-benchmarks.js` 现在负责参数校验、真实启动 `check-task-e2e-campaign.ts`、按 `--repeat` 创建不同 campaign，并生成 `tmp/shopgate-benchmark-reports/` 下的结构化汇总报告。
- `--model` 会覆盖本次 campaign 使用的模型并写入报告；`--repeat` 会形成独立物理运行；`--case`、`--limit`、`--keep-projects` 等入口参数会被显式解析，不支持的参数直接失败。
- `hidden` 只读取 `SHOPGATE_HIDDEN_EVAL_CASES_PATH`，`production_replay` 只读取 `SHOPGATE_PRODUCTION_REPLAY_CASES_PATH`。路径必须是仓库外的绝对普通文件，非公开报告只保存 case hash、能力、状态、耗时、产物检查和失败数量。
- `scripts/checks/check-eval-ci-gate.js` 现在核验对应结构化报告、模型、可见性、报告时效和阈值；它不再把公开数据集结构检查冒充成真实 E2E。
- `src/lib/eval` 的用例、评测集、dataset registry、snapshot manifest 和 judge contract 路径统一到 `config/evals/`，避免评测平台继续引用不存在的 `benchmarks/shopgate/` 目录。任务队列也能识别 commerce aggregate report。

## 验收命令

```bash
npm run benchmark:commerce:contract
npm run eval:ci
npm run check:retail-e2e -- --dataset-only
npm run benchmark:commerce:e2e -- --mode=e2e --dataset-visibility=public --model=deepseek-v4-flash --repeat=2 --dry-run
```

真实 E2E 仍需要运行中的 Shop Gate、数据库、登录配置和模型凭据；没有这些条件时只执行 contract、dry-run 和边界失败检查，不把“有脚本”写成“已完成真实运行”。
