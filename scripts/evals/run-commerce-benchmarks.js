#!/usr/bin/env node

// P9：金融 benchmarks/shopgate 评测体系已随金融域移除（P0 删数据、P3 删域）。
// 本文件原为金融基准运行器，其 import（src/lib/domains/finance/*、data-prefetch.ts）
// 已随金融域删除，无法再提供有效校验。零售域的真实校验由零售 task-E2E 基准承担：
//   npm run check:retail-e2e        （校验零售基准数据集与最近一次运行证据）
//   npm run check-task-e2e -- ...   （运行零售基准：check-task-e2e-campaign.ts
//                                     --dataset=task-e2e-retail-v1）

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
console.log('[eval-benchmarks] 金融基准运行器已随金融域移除；真实校验由零售 task-E2E 基准承担。');
