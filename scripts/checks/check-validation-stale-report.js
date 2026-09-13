#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-validation-stale-report.js'), {
  interopDefault: true,
});

const { readRetailValidationReport } = jiti('../../src/lib/commerce/retail-validation.ts');

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shopgate-stale-validation-'));
  try {
    await writeJson(path.join(projectPath, '.data-agent/validation.json'), {
      schemaVersion: 1,
      projectId: 'stale-validation-smoke',
      status: 'failed',
      passed: false,
      reportPath: '.data-agent/validation.json',
      checks: [
        {
          id: 'final_data_file',
          name: '最终数据文件',
          status: 'failed',
          summary: '旧报告：最终数据缺失。',
        },
      ],
      createdAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:01.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), {
      dataset_id: 'retail-stale-smoke',
      window: { start: '2026-05-25', end: '2026-05-26' },
      plannedEntities: { categoryIds: [], itemIds: [] },
      datasets: { meta: { event_count: 1 } },
    });
    await writeFile(
      path.join(projectPath, 'app/page.tsx'),
      `const DATA_FILE = 'data_file/final/dashboard-data.json';\nexport default function Page(){return <main data-source-file={DATA_FILE}>ok</main>}\n`
    );

    const report = await readRetailValidationReport(projectPath);
    const staleCheck = report?.checks?.find((check) => check.id === 'validation_report_stale');
    if (!report || !staleCheck) {
      console.error('[validation-stale] expected stale validation report warning');
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    console.log('[validation-stale] ok');
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[validation-stale] failed');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
