# PROVENANCE / 项目来源与边界说明

## 来源

- 蓝本项目：[QuantPilot](https://github.com/tiammomo/QuantPilot)，导入自本地克隆，HEAD `cfa3bdf`（`docs: fold stage3 (skills/domain-pack) into design principles ledger`），导入时工作区干净。
- 导入日期：2025-09-06。
- 上游协议：MIT License，Copyright (c) 2025 Opactor AI。根目录 `LICENSE` 保留原文，本文件不构成对上游版权声明的替代。
- Shop Gate 是以 QuantPilot 为蓝本的**全新独立项目**（零售电商领域 Data Agent），与上游无同步关系；`finance.quant` 领域包将按计划移除。

## 导入时排除的内容

运行产物与本地状态未进入仓库：

- `node_modules/`、`.next/`、`.venv/`（含 `services/market-data/.venv/`）、`__pycache__/`、`*.pyc`、`.ruff_cache/`
- `data/`、`tmp/`、`public/uploads/`、`public/generated/`（上游本地工作区与生成产物）
- `.env`、`.env.local`（凭据；新项目用 `npm run ensure:env` 重新生成）
- `.git/`（不继承上游历史，本仓库从本提交开始）

`benchmarks/` 随快照导入（保持"纯净快照"可审计），在 P0 的独立提交中删除。

## 命名合同例外（换牌不可触碰）

以下为 PI Agent 内核与数据平台的命名合同，品牌替换时保持原样：

1. `PiAgent*` 类型 / `PI_AGENT_*` 环境变量 / `.pi/` 目录 / `pi_agent_submit_result` —— PI Agent 命名合同，有自动检查（见 `docs/pi-agent-migration.md`）。
2. prisma migration —— 已有 migration 只追加、不修改 checksum；模型变更通过新 migration 完成。
3. `.data-agent` 工作空间合同（Domain Pack 生成产物的落盘契约）。

## P0 品牌替换范围

`QuantPilot/quantpilot/QUANTPILOT_` → `Shop Gate/shopgate/SHOPGATE_`；`services/market-data` → `services/commerce-data`（Python 包 `shopgate_commerce_data`，console 脚本 `shopgate-commerce-api`）；`src/lib/quant` → `src/lib/commerce`；`src/app/api/quant` → `src/app/api/commerce`；工具名 `quant_api_get` 等 → `commerce_*` 前缀。

明确**不在 P0 范围**：SQL 中 `quant.*` schema 名（P2 随新零售 schema 设计调整）、prisma 模型变更（P2/P3，追加式）、api 路由与领域文件的内容级重写（P3/P4）、skills 与评测内容（P8/P9）、docs 内容级重写（P10）。
