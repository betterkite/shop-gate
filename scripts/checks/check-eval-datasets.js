#!/usr/bin/env node

// P9：金融 benchmarks/shopgate 评测体系已随金融域移除（P0 删数据、P3 删域），
// 原 attest 逻辑引用的 src/lib/domains/finance/ 与 data-prefetch.ts 已不存在，
// 无法再提供有效校验。零售域的真实校验由零售 task-E2E 基准承担：
// 本入口执行 check-retail-e2e-benchmark（数据集结构 + 最近一次运行证据）并透传结果。

const { spawnSync } = require('child_process');
const path = require('path');

const retailCheck = path.join(
  process.cwd(),
  'scripts',
  'checks',
  'check-retail-e2e-benchmark.js',
);
const result = spawnSync(process.execPath, [retailCheck], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log('[eval-benchmarks] 金融基准体系已随金融域移除；真实校验由零售 task-E2E 基准承担。');
