#!/usr/bin/env node

/**
 * Shop Gate commerce benchmark runner.
 *
 * The public contract is deterministic and can run in a clean checkout. The
 * E2E mode is the real task runner: it starts the Playwright campaign and
 * writes one auditable aggregate report for every physical repeat. Hidden and
 * production-replay cases are accepted only from an external file and are
 * redacted before any aggregate artifact is written.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const PUBLIC_DATASET_ID = 'shopgate-task-e2e-retail-v1';
const PUBLIC_DATASET_NAME = 'task-e2e-retail-v1';
const PUBLIC_DATASET_PATH = path.join(ROOT, 'config', 'evals', `${PUBLIC_DATASET_NAME}.json`);
const TASK_RUNNER = path.join(ROOT, 'scripts', 'checks', 'check-task-e2e-campaign.ts');
const REPORTS_DIR = path.join(ROOT, 'tmp', 'shopgate-benchmark-reports');
const EXTERNAL_ENV_BY_VISIBILITY = Object.freeze({
  hidden: 'SHOPGATE_HIDDEN_EVAL_CASES_PATH',
  production_replay: 'SHOPGATE_PRODUCTION_REPLAY_CASES_PATH',
});
const VISIBILITIES = new Set(['public', 'hidden', 'production_replay']);
const MODES = new Set(['contract', 'e2e']);
const VALUE_OPTIONS = new Set([
  'mode', 'dataset', 'dataset-visibility', 'model', 'repeat', 'campaign', 'limit',
  'concurrency', 'timeout-ms', 'poll-ms', 'retry-failed', 'only', 'case', 'report',
  'cli', 'reasoning-effort', 'trigger', 'evaluator',
]);
const FLAG_OPTIONS = new Set(['cleanup', 'retain-projects', 'keep-projects', 'dry-run', 'help']);

function fail(message) {
  throw new Error(message);
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function parseBenchmarkArgs(argv) {
  const values = new Map();
  const repeated = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) fail(`只支持长参数，收到：${raw}`);
    const token = raw.slice(2);
    const separator = token.indexOf('=');
    const name = separator >= 0 ? token.slice(0, separator) : token;
    const inlineValue = separator >= 0 ? token.slice(separator + 1) : null;
    if (!VALUE_OPTIONS.has(name) && !FLAG_OPTIONS.has(name)) {
      fail(`不支持的 benchmark 参数：--${name}。参数不会被静默忽略。`);
    }
    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== null) fail(`--${name} 不接受值。`);
      flags.add(name);
      continue;
    }
    const value = inlineValue !== null ? inlineValue : argv[index + 1];
    if (!value || value.startsWith('--')) fail(`--${name} 缺少值。`);
    if (inlineValue === null) index += 1;
    if (name === 'case') {
      if (!repeated.has(name)) repeated.set(name, []);
      repeated.get(name).push(value.trim());
    } else {
      values.set(name, value.trim());
    }
  }
  if (flags.has('help')) return { help: true };
  return { values, repeated, flags };
}

function integerOption(values, name, fallback, min, max) {
  const raw = values.get(name);
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`--${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

function safeCampaign(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/u.test(value)) {
    fail('--campaign 必须包含 1-24 个小写字母、数字或短横线。');
  }
  return value;
}

function defaultCampaign() {
  return `retail-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
}

function campaignForRepeat(base, visibility, repeat, repeatCount) {
  const prefix = visibility === 'public' ? '' : `external-${visibility}-`;
  const suffix = repeatCount > 1 ? `-r${repeat}` : '';
  const campaign = `${prefix}${base}${suffix}`;
  return safeCampaign(campaign);
}

function externalDatasetPath(visibility) {
  const envName = EXTERNAL_ENV_BY_VISIBILITY[visibility];
  const raw = process.env[envName]?.trim();
  if (!raw) fail(`${envName} 未配置；${visibility} dataset 只能通过外部文件注入。`);
  if (!path.isAbsolute(raw)) fail(`${envName} 必须是绝对路径。`);
  const resolved = path.resolve(raw);
  const relative = path.relative(ROOT, resolved);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    fail(`${envName} 指向仓库内部路径，拒绝读取公开仓库中的非公开 dataset。`);
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail(`${envName} 必须指向一个外部普通文件。`);
  return resolved;
}

function normalizeOptions(parsed) {
  const { values, repeated, flags } = parsed;
  const mode = values.get('mode') ?? 'contract';
  if (!MODES.has(mode)) fail(`不支持的评测模式：${mode}。`);
  const visibility = values.get('dataset-visibility') ?? 'public';
  if (!VISIBILITIES.has(visibility)) fail(`不支持的数据集可见性：${visibility}。`);
  if (mode === 'contract' && visibility !== 'public') {
    fail('contract 模式只能校验公开 dataset；隐藏集和生产回放必须显式使用 e2e 模式。');
  }

  const dataset = values.get('dataset') ?? PUBLIC_DATASET_NAME;
  if (visibility === 'public' && dataset !== PUBLIC_DATASET_NAME) {
    fail(`公开 benchmark 只允许 ${PUBLIC_DATASET_NAME}，收到：${dataset}。`);
  }
  if (visibility !== 'public' && values.has('dataset')) {
    fail('非公开 benchmark 不接受仓库内 --dataset；请通过对应外部环境变量注入文件。');
  }
  const repeat = integerOption(values, 'repeat', 1, 1, 5);
  if (mode === 'contract' && repeat !== 1) fail('contract 模式不支持重复运行；请使用 --repeat=1。');
  const baseCampaign = safeCampaign(values.get('campaign') ?? defaultCampaign());
  const model = values.get('model') ?? null;
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$/u.test(model)) {
    fail('--model 包含不安全字符或长度超过 100。');
  }
  const selectedCases = [
    ...(repeated.get('case') ?? []),
    ...(values.get('only') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  ];
  const uniqueCases = [...new Set(selectedCases)];
  return {
    mode,
    visibility,
    dataset,
    model,
    repeat,
    baseCampaign,
    limit: values.has('limit') ? integerOption(values, 'limit', 30, 1, 1000) : null,
    concurrency: values.has('concurrency') ? integerOption(values, 'concurrency', 2, 1, 4) : null,
    timeoutMs: values.has('timeout-ms') ? integerOption(values, 'timeout-ms', 1_200_000, 60_000, 3_600_000) : null,
    pollMs: values.has('poll-ms') ? integerOption(values, 'poll-ms', 5_000, 1_000, 30_000) : null,
    retryFailed: values.has('retry-failed') ? integerOption(values, 'retry-failed', 2, 2, 99) : null,
    selectedCases: uniqueCases,
    cleanup: flags.has('cleanup'),
    retainProjects: flags.has('retain-projects') || flags.has('keep-projects'),
    dryRun: flags.has('dry-run'),
    cli: values.get('cli') ?? null,
    reasoningEffort: values.get('reasoning-effort') ?? null,
    trigger: values.get('trigger') ?? null,
    evaluator: values.get('evaluator') ?? null,
    externalPath: visibility === 'public' ? null : externalDatasetPath(visibility),
    reportPath: values.get('report') ?? null,
  };
}

function reportFileForCampaign(campaign, visibility) {
  const prefix = visibility === 'public' ? 'task-e2e-' : `task-e2e-external-${visibility}-`;
  return path.join(ROOT, 'tmp', `${prefix}${campaign}-latest.json`);
}

function reportTarget(options) {
  if (options.reportPath) {
    const target = path.resolve(ROOT, options.reportPath);
    const relative = path.relative(REPORTS_DIR, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail('--report 必须位于 tmp/shopgate-benchmark-reports/ 内。');
    }
    if (!target.endsWith('.json')) fail('--report 必须是 JSON 文件。');
    return target;
  }
  return path.join(
    REPORTS_DIR,
    `commerce-${options.mode}-${options.visibility}-${options.baseCampaign}-latest.json`,
  );
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadPublicDataset() {
  if (!fs.existsSync(PUBLIC_DATASET_PATH)) fail(`公开零售 dataset 缺失：${path.relative(ROOT, PUBLIC_DATASET_PATH)}`);
  const dataset = JSON.parse(fs.readFileSync(PUBLIC_DATASET_PATH, 'utf8'));
  if (dataset.schemaVersion !== 1 || dataset.id !== PUBLIC_DATASET_ID || !Array.isArray(dataset.cases)) {
    fail('公开零售 dataset 不符合 schema v1 或 dataset id 不匹配。');
  }
  return dataset;
}

function buildContractReport(options, dataset) {
  const now = new Date().toISOString();
  const summary = {
    total: dataset.cases.length,
    passedCount: dataset.cases.length,
    failedCount: 0,
    passRate: 100,
    averageScore: 100,
    firstPassRate: 100,
    repairRate: 0,
    stabilityRate: 100,
    stabilityConfidenceLower: 100,
    scoreStandardDeviation: 0,
  };
  return {
    schemaVersion: 1,
    kind: 'shopgate-commerce-benchmark',
    mode: 'contract',
    createdAt: now,
    finishedAt: now,
    passed: true,
    total: summary.total,
    passedCount: summary.passedCount,
    failedCount: summary.failedCount,
    runtime: { cli: 'contract', model: 'deterministic', provider: null },
    dataset: {
      id: dataset.id,
      visibility: 'public',
      promptsRedacted: false,
      source: 'repository:config/evals/task-e2e-retail-v1.json',
      sourceIdentitySha256: hash(fs.readFileSync(PUBLIC_DATASET_PATH)),
    },
    selection: { caseCount: dataset.cases.length, repeat: 1, concurrency: 1 },
    summary,
    metadata: {
      runtime: { cli: 'contract', model: 'deterministic', agentExecuted: false },
      dataset: { schemaVersion: 1, visibility: 'public', promptsRedacted: false },
      selection: { repeat: 1, concurrency: 1, caseCount: dataset.cases.length },
      suite: { mode: 'contract', executionClass: 'deterministic_contract' },
      startedAt: now,
      finishedAt: now,
    },
    results: [],
    runs: [{ campaign: null, exitCode: 0, reportPath: null, summary: { passed: dataset.cases.length, total: dataset.cases.length } }],
    requested: { mode: options.mode, datasetVisibility: options.visibility },
  };
}

function extractChildSummary(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // The runner may emit pretty JSON; report file remains the source of truth.
    }
  }
  return null;
}

function spawnTaskRun(options, campaign) {
  const args = [
    '--env-file-if-exists=.env.local',
    '--import',
    'tsx',
    TASK_RUNNER,
    `--dataset-visibility=${options.visibility}`,
    `--campaign=${campaign}`,
  ];
  if (options.visibility === 'public') args.push(`--dataset=${options.dataset}`);
  else args.push(`--cases-file=${options.externalPath}`);
  if (options.model) args.push(`--model=${options.model}`);
  if (options.limit !== null) args.push(`--limit=${options.limit}`);
  if (options.concurrency !== null) args.push(`--concurrency=${options.concurrency}`);
  if (options.timeoutMs !== null) args.push(`--timeout-ms=${options.timeoutMs}`);
  if (options.pollMs !== null) args.push(`--poll-ms=${options.pollMs}`);
  if (options.retryFailed !== null) args.push(`--retry-failed=${options.retryFailed}`);
  if (options.selectedCases.length) args.push(`--only=${options.selectedCases.join(',')}`);
  if (options.cleanup) args.push('--cleanup');
  if (options.retainProjects) args.push('--retain-projects');
  if (options.visibility !== 'public') args.push('--redact-report');
  const env = {
    ...process.env,
    ...(options.model ? { SHOPGATE_EVAL_MODEL: options.model } : {}),
    ...(options.cli ? { SHOPGATE_EVAL_CLI: options.cli } : {}),
    ...(options.reasoningEffort ? { SHOPGATE_EVAL_REASONING_EFFORT: options.reasoningEffort } : {}),
    ...(options.trigger ? { SHOPGATE_EVAL_TRIGGER: options.trigger } : {}),
    ...(options.evaluator ? { SHOPGATE_EVAL_EVALUATOR: options.evaluator } : {}),
  };
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reportPath = reportFileForCampaign(campaign, options.visibility);
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    : null;
  return {
    campaign,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    reportPath: fs.existsSync(reportPath) ? path.relative(ROOT, reportPath) : null,
    report,
    childSummary: extractChildSummary(result.stdout),
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function resultPassed(result) {
  return result && result.passed === true;
}

function wilsonLowerPercent(successes, total) {
  if (!total) return 0;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, ((centre - spread) / denominator) * 100);
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
}

function redactResult(result) {
  return {
    id: hash(result?.id),
    capabilityId: result?.capabilityId ?? null,
    model: result?.model ?? null,
    state: result?.state ?? 'failed',
    passed: resultPassed(result),
    startedAt: result?.startedAt ?? null,
    completedAt: result?.completedAt ?? null,
    elapsedMs: Number(result?.elapsedMs ?? 0),
    artifactChecks: result?.artifactChecks ?? {},
    previewHttpStatus: result?.previewHttpStatus ?? null,
    failureCount: Array.isArray(result?.failures) ? result.failures.length : 0,
    failures: Array.isArray(result?.failures) && result.failures.length ? ['redacted'] : [],
  };
}

function aggregateReport(options, runs) {
  const childReports = runs.map((run) => run.report).filter((report) => report && typeof report === 'object');
  const firstReport = childReports[0] ?? {};
  const firstResults = Array.isArray(firstReport.results) ? firstReport.results : [];
  const allResults = childReports.flatMap((report) => Array.isArray(report.results) ? report.results : []);
  const total = allResults.length;
  const passedCount = allResults.filter(resultPassed).length;
  const firstPassCount = firstResults.filter(resultPassed).length;
  const caseIds = [...new Set(firstResults.map((result) => result?.id).filter(Boolean))];
  const stableCount = caseIds.filter((caseId) => childReports.every((report) => {
    const result = (Array.isArray(report.results) ? report.results : []).find((item) => item?.id === caseId);
    return resultPassed(result);
  })).length;
  const scoreValues = allResults.map((result) => resultPassed(result) ? 100 : 0);
  const summary = {
    total,
    passedCount,
    failedCount: total - passedCount,
    passRate: total ? (passedCount / total) * 100 : 0,
    averageScore: total ? (passedCount / total) * 100 : 0,
    firstPassRate: firstResults.length ? (firstPassCount / firstResults.length) * 100 : 0,
    repairRate: 0,
    stabilityRate: caseIds.length ? (stableCount / caseIds.length) * 100 : 0,
    stabilityConfidenceLower: wilsonLowerPercent(stableCount, caseIds.length),
    scoreStandardDeviation: standardDeviation(scoreValues),
  };
  const reportRuns = runs.map((run) => ({
    campaign: run.campaign,
    exitCode: run.exitCode,
    signal: run.signal,
    reportPath: run.reportPath,
    summary: run.report?.summary ?? run.childSummary ?? null,
    results: options.visibility === 'public'
      ? (Array.isArray(run.report?.results) ? run.report.results : [])
      : (Array.isArray(run.report?.results) ? run.report.results.map(redactResult) : []),
  }));
  const reportResults = reportRuns.flatMap((run) => run.results);
  const report = {
    schemaVersion: 1,
    kind: 'shopgate-commerce-benchmark',
    mode: 'e2e',
    createdAt: childReports[0]?.checkedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    passed: summary.failedCount === 0 && runs.every((run) => run.exitCode === 0),
    total: summary.total,
    passedCount: summary.passedCount,
    failedCount: summary.failedCount,
    runtime: {
      cli: options.cli ?? 'pi',
      model: options.model ?? firstResults[0]?.model ?? null,
      provider: options.model?.startsWith('deepseek') ? 'deepseek' : null,
    },
    dataset: {
      id: options.visibility === 'public' ? PUBLIC_DATASET_ID : 'external-eval-dataset',
      visibility: options.visibility,
      promptsRedacted: options.visibility !== 'public',
      source: options.visibility === 'public'
        ? 'repository:config/evals/task-e2e-retail-v1.json'
        : 'external-dataset',
      sourceIdentitySha256: options.visibility === 'public'
        ? hash(fs.readFileSync(PUBLIC_DATASET_PATH))
        : hash(fs.readFileSync(options.externalPath)),
    },
    selection: {
      caseCount: caseIds.length,
      repeat: runs.length,
      concurrency: options.concurrency,
      limit: options.limit,
    },
    summary,
    metadata: {
      runtime: { cli: options.cli ?? 'pi', model: options.model ?? firstResults[0]?.model ?? null, agentExecuted: true },
      dataset: { schemaVersion: 1, visibility: options.visibility, promptsRedacted: options.visibility !== 'public' },
      selection: { repeat: runs.length, concurrency: options.concurrency, caseCount: caseIds.length, limit: options.limit },
      suite: { mode: 'e2e', executionClass: 'live_mission_e2e' },
      startedAt: childReports[0]?.checkedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
    results: reportResults,
    runs: reportRuns,
    requested: {
      model: options.model,
      repeat: options.repeat,
      datasetVisibility: options.visibility,
      selectedCases: options.visibility === 'public' ? options.selectedCases : options.selectedCases.map(hash),
    },
  };
  return report;
}

function printHelp() {
  console.log(`用法：npm run benchmark:commerce:contract 或 npm run benchmark:commerce:e2e -- [参数]\n\n` +
    'E2E 参数：--model --repeat=1..5 --dataset-visibility=public|hidden|production_replay --campaign --limit --concurrency\n' +
    '边界：hidden 使用 SHOPGATE_HIDDEN_EVAL_CASES_PATH；production_replay 使用 SHOPGATE_PRODUCTION_REPLAY_CASES_PATH。\n' +
    '辅助：--dry-run 输出计划但不启动真实任务；--report 只能写入 tmp/shopgate-benchmark-reports/。');
}

function main() {
  const parsed = parseBenchmarkArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  const options = normalizeOptions(parsed);
  if (options.mode === 'contract') {
    const dataset = loadPublicDataset();
    const contractCheck = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'checks', 'check-retail-e2e-benchmark.js'),
      '--dataset-only',
    ], { cwd: ROOT, stdio: 'inherit' });
    if (contractCheck.status !== 0) process.exit(contractCheck.status || 1);
    const report = buildContractReport(options, dataset);
    const target = reportTarget(options);
    writeJson(target, report);
    console.log(JSON.stringify({ mode: 'contract', reportPath: path.relative(ROOT, target), summary: report.summary }, null, 2));
    return;
  }
  if (options.dryRun) {
    const campaigns = Array.from({ length: options.repeat }, (_, index) =>
      campaignForRepeat(options.baseCampaign, options.visibility, index + 1, options.repeat));
    console.log(JSON.stringify({ mode: options.mode, datasetVisibility: options.visibility, model: options.model, repeat: options.repeat, campaigns }, null, 2));
    return;
  }
  const runs = [];
  for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
    const campaign = campaignForRepeat(options.baseCampaign, options.visibility, repeat, options.repeat);
    const run = spawnTaskRun(options, campaign);
    runs.push(run);
    if (options.visibility === 'public') {
      if (run.stderr) process.stderr.write(run.stderr);
      if (run.stdout) process.stdout.write(run.stdout);
    } else {
      process.stderr.write(`[eval-benchmarks] external campaign ${campaign} exited ${run.exitCode}.\n`);
    }
  }
  const report = aggregateReport(options, runs);
  const target = reportTarget(options);
  writeJson(target, report);
  console.log(JSON.stringify({
    mode: 'e2e',
    datasetVisibility: options.visibility,
    model: report.runtime.model,
    repeat: runs.length,
    reportPath: path.relative(ROOT, target),
    summary: report.summary,
  }, null, 2));
  if (runs.some((run) => run.exitCode !== 0) || report.summary.failedCount > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[eval-benchmarks] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  aggregateReport,
  buildContractReport,
  parseBenchmarkArgs,
  redactResult,
  wilsonLowerPercent,
};
