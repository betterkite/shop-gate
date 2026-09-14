#!/usr/bin/env node

/**
 * Independent gate for the commerce benchmark aggregate report.
 *
 * The benchmark runner owns execution; this command only attests the report
 * that was produced by that execution. Keeping the two commands separate
 * prevents a contract-only check from masquerading as a live E2E run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, 'tmp', 'shopgate-benchmark-reports');
const MODES = new Set(['contract', 'e2e']);
const VISIBILITIES = new Set(['public', 'hidden', 'production_replay']);
const VALUE_OPTIONS = new Set([
  'mode', 'dataset-visibility', 'model', 'max-age-hours', 'report', 'repeat',
  'min-pass-rate', 'min-average-score', 'min-first-pass-rate', 'max-repair-rate',
  'min-stability-rate', 'min-stability-confidence-lower', 'max-score-standard-deviation',
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) fail(`只支持长参数，收到：${raw}`);
    const token = raw.slice(2);
    const separator = token.indexOf('=');
    const name = separator >= 0 ? token.slice(0, separator) : token;
    const inlineValue = separator >= 0 ? token.slice(separator + 1) : null;
    if (name === 'help') return { help: true };
    if (!VALUE_OPTIONS.has(name)) fail(`不支持的 eval gate 参数：--${name}。参数不会被静默忽略。`);
    const value = inlineValue !== null ? inlineValue : argv[index + 1];
    if (!value || value.startsWith('--')) fail(`--${name} 缺少值。`);
    if (inlineValue === null) index += 1;
    values.set(name, value.trim());
  }
  return { values };
}

function numberOption(values, name, fallback, min, max) {
  const value = Number(values.get(name) ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`--${name} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  return value;
}

function safeReportPath(value) {
  const target = path.resolve(ROOT, value);
  const relative = path.relative(REPORTS_DIR, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !target.endsWith('.json')) {
    fail('--report 必须是 tmp/shopgate-benchmark-reports/ 内的 JSON 文件。');
  }
  return target;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取评测报告 ${path.relative(ROOT, filePath)}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function findReport(mode, visibility, explicitPath) {
  if (explicitPath) {
    const target = safeReportPath(explicitPath);
    if (!fs.existsSync(target)) fail(`评测报告不存在：${path.relative(ROOT, target)}`);
    return { filePath: target, report: readJson(target) };
  }
  if (!fs.existsSync(REPORTS_DIR)) fail('评测报告目录不存在，请先运行 benchmark。');
  const candidates = fs.readdirSync(REPORTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const filePath = path.join(REPORTS_DIR, name);
      const report = readJson(filePath);
      const stat = fs.statSync(filePath);
      return { filePath, report, mtimeMs: stat.mtimeMs };
    })
    .filter(({ report }) => report?.kind === 'shopgate-commerce-benchmark'
      && report.mode === mode
      && report.dataset?.visibility === visibility)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) {
    fail(`没有找到 mode=${mode}, visibility=${visibility} 的结构化 benchmark 报告。`);
  }
  return candidates[0];
}

function assertSafeExternalReport(report) {
  if (report.dataset?.promptsRedacted !== true) {
    fail('非公开报告必须声明 promptsRedacted=true。');
  }
  const serialized = JSON.stringify(report);
  if (/SHOPGATE_(?:HIDDEN_EVAL_CASES_PATH|PRODUCTION_REPLAY_CASES_PATH)/u.test(serialized)) {
    fail('非公开报告泄露了外部 dataset 环境变量名。');
  }
  if (/(?:\/run\/secrets\/|cases-file|sourcePath|externalPath)/u.test(serialized)) {
    fail('非公开报告泄露了外部 dataset 路径或路径字段。');
  }
  const results = report.runs?.flatMap((run) => Array.isArray(run.results) ? run.results : []) ?? [];
  if (results.some((result) => Object.prototype.hasOwnProperty.call(result, 'question'))) {
    fail('非公开报告不能包含 question 明文字段。');
  }
}

function assertThresholds(report, values) {
  const summary = report.summary ?? {};
  const checks = [
    ['passRate', 'min-pass-rate', numberOption(values, 'min-pass-rate', 100, 0, 100), (actual, expected) => actual >= expected],
    ['averageScore', 'min-average-score', numberOption(values, 'min-average-score', 90, 0, 100), (actual, expected) => actual >= expected],
    ['firstPassRate', 'min-first-pass-rate', numberOption(values, 'min-first-pass-rate', 100, 0, 100), (actual, expected) => actual >= expected],
    ['repairRate', 'max-repair-rate', numberOption(values, 'max-repair-rate', 0, 0, 100), (actual, expected) => actual <= expected],
    ['stabilityRate', 'min-stability-rate', numberOption(values, 'min-stability-rate', 100, 0, 100), (actual, expected) => actual >= expected],
    ['stabilityConfidenceLower', 'min-stability-confidence-lower', numberOption(values, 'min-stability-confidence-lower', 75, 0, 100), (actual, expected) => actual >= expected],
    ['scoreStandardDeviation', 'max-score-standard-deviation', numberOption(values, 'max-score-standard-deviation', 0, 0, 100), (actual, expected) => actual <= expected],
  ];
  const failures = [];
  for (const [field, option, expected, passes] of checks) {
    const actual = Number(summary[field]);
    if (!Number.isFinite(actual) || !passes(actual, expected)) {
      failures.push(`${field}=${Number.isFinite(actual) ? actual : 'missing'} 未满足 ${option}=${expected}`);
    }
  }
  if (failures.length) fail(failures.join('；'));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log('用法：node scripts/checks/check-eval-ci-gate.js --mode contract|e2e [--dataset-visibility public|hidden|production_replay] [阈值]');
    return;
  }
  const { values } = parsed;
  const mode = values.get('mode') ?? 'contract';
  const visibility = values.get('dataset-visibility') ?? 'public';
  if (!MODES.has(mode)) fail(`不支持的评测模式：${mode}。`);
  if (!VISIBILITIES.has(visibility)) fail(`不支持的数据集可见性：${visibility}。`);
  if (mode === 'contract' && visibility !== 'public') fail('contract gate 只能校验 public dataset。');
  const { filePath, report } = findReport(mode, visibility, values.get('report'));
  if (report.schemaVersion !== 1) fail('benchmark 报告 schemaVersion 必须为 1。');
  if (!report.summary || Number(report.summary.total) <= 0) fail('benchmark 报告没有可核验的 case。');
  const finishedAt = Date.parse(report.finishedAt ?? report.createdAt ?? '');
  const maxAgeHours = numberOption(values, 'max-age-hours', 48, 0, 24 * 365);
  if (!Number.isFinite(finishedAt)) fail('benchmark 报告缺少有效 finishedAt/createdAt。');
  if (Date.now() - finishedAt > maxAgeHours * 60 * 60 * 1000) {
    fail(`benchmark 报告已超过 ${maxAgeHours} 小时：${path.relative(ROOT, filePath)}。`);
  }
  const expectedModel = values.get('model');
  if (expectedModel && report.runtime?.model !== expectedModel) {
    fail(`报告 runtime.model=${report.runtime?.model ?? 'missing'}，不符合 --model=${expectedModel}。`);
  }
  const expectedRepeat = values.get('repeat');
  if (expectedRepeat && Number(report.selection?.repeat) !== Number(expectedRepeat)) {
    fail(`报告 repeat=${report.selection?.repeat ?? 'missing'}，不符合 --repeat=${expectedRepeat}。`);
  }
  if (visibility !== 'public') assertSafeExternalReport(report);
  assertThresholds(report, values);
  console.log(JSON.stringify({
    status: 'passed',
    mode,
    datasetVisibility: visibility,
    reportPath: path.relative(ROOT, filePath),
    runtime: report.runtime,
    selection: report.selection,
    summary: report.summary,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[eval-gate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
