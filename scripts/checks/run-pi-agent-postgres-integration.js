#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    '[pi-agent-postgres] PI_AGENT_TEST_DATABASE_URL is required; use an isolated disposable PostgreSQL database.'
  );
  process.exit(1);
}

const prismaPackage = require.resolve('prisma/package.json');
const prismaBin = path.join(path.dirname(prismaPackage), 'build', 'index.js');
console.log('[pi-agent-postgres] Applying real migrations to the disposable database...');
const provision = spawnSync(
  process.execPath,
  [prismaBin, 'migrate', 'deploy'],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  }
);
if (provision.error) {
  console.error(`[pi-agent-postgres] Failed to provision schema: ${provision.error.message}`);
  process.exit(1);
}
if (provision.signal || provision.status !== 0) {
  console.error(
    `[pi-agent-postgres] Schema provisioning failed${
      provision.signal ? ` on signal ${provision.signal}` : ` with status ${provision.status}`
    }.`
  );
  process.exit(1);
}

const vitestPackage = require.resolve('vitest/package.json');
const vitestBin = path.join(path.dirname(vitestPackage), 'vitest.mjs');
const testFiles = [
  'src/lib/agent/runtime/prisma-repository.integration.test.ts',
  'src/lib/services/pi-agent-tool-approval-store.integration.test.ts',
  'src/lib/agent/runtime/bi-scope.integration.test.ts',
  'src/lib/agent/runtime/bi-scope-migration.integration.test.ts',
  'src/lib/bi/agent/requests.integration.test.ts',
  'src/lib/bi/agent/results.integration.test.ts',
  'src/lib/bi/agent/execution.integration.test.ts',
  'src/lib/services/pi-agent-usage-reconciliation.integration.test.ts',
  'src/lib/services/pi-agent-execution-accounting.integration.test.ts',
];
const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'shopgate-agent-pg-report-'));
let exitCode = 1;
try {
  const reportPath = path.join(reports, 'result.json');
  const result = spawnSync(process.execPath, [vitestBin, 'run', ...testFiles,
    '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`Vitest failed: ${result.signal ?? result.status}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.success !== true || !Number.isInteger(report.numTotalTests)
      || report.numTotalTests < 88 || report.numPendingTests !== 0
      || report.numTodoTests !== 0 || report.numFailedTests !== 0
      || report.numPassedTests !== report.numTotalTests) {
    throw new Error('The required PostgreSQL checks did not all execute and pass.');
  }
  console.log(`[pi-agent-postgres] ${report.numPassedTests} real PostgreSQL tests passed; none skipped.`);
  exitCode = 0;
} catch (error) {
  console.error(`[pi-agent-postgres] ${error.message}`);
} finally {
  fs.rmSync(reports, { recursive: true, force: true });
}
process.exitCode = exitCode;
