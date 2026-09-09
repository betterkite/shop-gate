#!/usr/bin/env node

// 评测 mutation 入口统一复用零售 task-E2E 基准，避免维护第二套数据合同。

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
