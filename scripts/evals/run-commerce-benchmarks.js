#!/usr/bin/env node

// Commerce benchmark wrapper: contract/e2e modes now use the retail task-E2E
// dataset and do not depend on the removed QuantPilot finance benchmark code:
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
console.log('[eval-benchmarks] commerce benchmark wrapper completed; retail task-E2E is the source of truth.');
