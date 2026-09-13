#!/usr/bin/env node

// 评测 CI gate 统一复用零售 task-E2E 契约，避免维护第二套数据合同。
// contract 在干净 checkout 上验证公开数据集；e2e 才检查真实运行证据。

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

const checkArgs = [retailCheck, mode === 'e2e' ? '--require-evidence' : '--dataset-only'];
const result = spawnSync(process.execPath, checkArgs, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(`[eval-benchmarks] ${mode} gate 已委托零售 task-E2E 契约。`);
