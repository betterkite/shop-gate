#!/usr/bin/env node

// Commerce benchmark 命令统一复用零售 task-E2E 基准，避免维护第二套数据合同：
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
