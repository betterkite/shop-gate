#!/usr/bin/env node

/**
 * 零售 task-E2E 基准校验（P9 替代已删除的金融 benchmarks/shopgate 数据体系）。
 *
 * 校验对象（真实存在的零售基准）：
 *  1. config/evals/task-e2e-retail-v1.json —— 30 条零售 case，能力 ∈ 零售 4 能力，id 唯一；
 *  2. 最近一次运行证据 tmp/task-e2e-retail-*-latest.json —— 存在且 passRate>0。
 *
 * 这是"恢复真实校验"的入口：基准数据缺失/损坏、或从未成功运行过 → 失败（不再静默 SKIPPED）。
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const DATASET_PATH = path.resolve('config/evals/task-e2e-retail-v1.json');
const RETAIL_CAPABILITIES = new Set([
  'catalog_structure',
  'traffic_funnel',
  'price_inventory',
  'daily_brief',
]);
const REPORT_DIR = path.resolve('tmp');
const REQUIRED_CASES = 30;

function fail(message) {
  console.error(`[retail-e2e] FAIL: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  if (!fs.existsSync(DATASET_PATH)) {
    fail(`零售基准数据集缺失：${path.relative(root, DATASET_PATH)}`);
  }
  const dataset = readJson(DATASET_PATH);
  if (dataset.schemaVersion !== 1) fail('数据集 schemaVersion 必须为 1。');
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== REQUIRED_CASES) {
    fail(`零售基准必须包含 ${REQUIRED_CASES} 条 case，实际 ${dataset.cases?.length ?? 0}。`);
  }
  const ids = dataset.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail('零售基准 case id 存在重复。');

  for (const item of dataset.cases) {
    for (const key of ['id', 'capabilityId', 'model', 'question']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) {
        fail(`case ${item.id ?? '(无 id)'} 缺少字段 ${key}。`);
      }
    }
    if (!RETAIL_CAPABILITIES.has(item.capabilityId)) {
      fail(`case ${item.id} 的 capabilityId=${item.capabilityId} 不是零售能力。`);
    }
    if (!/[\u4e00-\u9fa5]/.test(item.question)) {
      fail(`case ${item.id} 的 question 应为零售中文问法。`);
    }
  }

  // 最近一次运行证据：证明基准真实可运行。
  const reports = fs
    .readdirSync(REPORT_DIR)
    .filter((name) => /^task-e2e-retail-.*-latest\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(REPORT_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (reports.length === 0) {
    fail('没有任何零售基准运行证据（tmp/task-e2e-retail-*-latest.json）。请先运行基准。');
  }
  const latest = readJson(reports[0].filePath);
  const summary = latest?.summary ?? {};
  const ready = Number(summary.ready ?? 0);
  const total = Number(summary.recorded ?? summary.selected ?? 0);
  if (!(total > 0 && ready > 0)) {
    fail(
      `最近一次零售基准运行没有任何通过 case（${reports[0].name}: ready=${ready}, total=${total}）。`,
    );
  }
  console.log(
    `[retail-e2e] ok: 数据集 ${dataset.id} ${dataset.cases.length} 条 case ` +
      `(能力: ${RETAIL_CAPABILITIES.size} 个)，最近运行证据 ${reports[0].name} ` +
      `ready=${ready}/${total}。`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    '[retail-e2e] failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
