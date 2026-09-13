#!/usr/bin/env node

// Commerce benchmark 命令统一复用零售 task-E2E 契约，避免维护第二套数据合同：
//   contract：校验公开零售基准数据集，可在干净 checkout 执行；
//   e2e：校验已经由 check-task-e2e 记录的真实运行证据。
// 真实运行入口：npm run check:task-e2e -- --dataset=task-e2e-retail-v1

const { spawnSync } = require('child_process');
const path = require('path');

const retailCheck = path.join(
  process.cwd(),
  'scripts',
  'checks',
  'check-retail-e2e-benchmark.js',
);
function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const equals = process.argv.find((arg) => arg.startsWith(prefix));
  if (equals) return equals.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const mode = argValue('mode', 'contract');
if (!['contract', 'e2e'].includes(mode)) {
  console.error(`[eval-benchmarks] 不支持的评测模式：${mode}。`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [retailCheck, mode === 'e2e' ? '--require-evidence' : '--dataset-only'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status || 1);
console.log(`[eval-benchmarks] ${mode} 基准契约校验完成。`);
