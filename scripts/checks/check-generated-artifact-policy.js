#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-generated-artifact-policy.js'), {
  interopDefault: true,
});

const { checkRetailArtifactPolicy } = jiti('../../src/lib/commerce/retail-validation.ts');

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createBaseProject(projectPath) {
  await writeJson(path.join(projectPath, '.data-agent/retail-run-plan.json'), {
    schemaVersion: 1,
    capabilityId: 'traffic_funnel',
    entities: ['cat:10051'],
    plannedEntities: { categoryIds: [10051], itemIds: [] },
    visualization: {
      templateId: 'funnel-analysis',
      panels: ['funnel', 'daily-trend'],
    },
  });
  await writeJson(path.join(projectPath, 'data_file/final/dashboard-data.json'), {
    dataset_id: 'retail-contract-fixture',
    dataset_name: '零售合同夹具',
    window: { start: '2026-05-22', end: '2026-05-25' },
    plannedEntities: { categoryIds: [10051], itemIds: [] },
    datasets: {
      meta: { event_count: 120, user_count: 48, item_count: 20 },
      funnel: {
        stages: [
          { stage: 'pv', events: 100, unique_users: 48 },
          { stage: 'fav', events: 28, unique_users: 22 },
          { stage: 'cart', events: 18, unique_users: 16 },
          { stage: 'buy', events: 8, unique_users: 8 },
        ],
      },
      funnelDaily: {
        rows: [{ stat_date: '2026-05-25', pv: 40, fav: 12, cart: 8, buy: 4 }],
      },
    },
  });
  await writeJson(path.join(projectPath, 'evidence/sources.json'), {
    sources: [
      {
        source: 'retail-contract-fixture',
        endpoint: '/api/v1/commerce/funnel',
        fetched_at: '2026-05-25T00:00:00.000Z',
        artifact_path: 'data_file/final/dashboard-data.json',
      },
    ],
  });
  await writeJson(path.join(projectPath, 'evidence/data_quality.json'), {
    status: 'ok',
    datasets: [{ id: 'funnel', row_count: 4, status: 'ok' }],
    warnings: [],
    limitations: [],
  });
  await writeJson(path.join(projectPath, 'package.json'), {
    scripts: { build: 'next build' },
    dependencies: { next: '^16.2.6', react: '^19.2.6', 'react-dom': '^19.2.6' },
  });
}

async function main() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shopgate-artifact-policy-'));

  try {
    await createBaseProject(projectPath);
    await writeFile(
      path.join(projectPath, 'app/page.tsx'),
      `const MOCK_DATA = { price: 1 };
export default function Page() {
  return (
    <main>
      <script src="https://cdn.jsdelivr.net/npm/echarts"></script>
      <div>{MOCK_DATA.price}</div>
    </main>
  );
}
`
    );

    const failed = await checkRetailArtifactPolicy(projectPath);
    const failedDetails = `${failed.summary}\n${failed.details ?? ''}`;
    const failedAsExpected =
      failed.status === 'failed' &&
      failedDetails.includes('外部') &&
      failedDetails.includes('MOCK_DATA');

    if (!failedAsExpected) {
      console.error('[artifact-policy] expected failed policy check');
      console.error(JSON.stringify(failed, null, 2));
      process.exit(1);
    }

    await writeFile(
      path.join(projectPath, 'app/page.tsx'),
      `import fs from 'fs/promises';

const DATA_FILE = 'data_file/final/dashboard-data.json';

export default async function Page() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const data = JSON.parse(raw) as {
    dataset_id?: string;
    datasets?: { funnel?: { stages?: Array<{ stage?: string; events?: number }> } };
  };

  return (
    <main data-source-file={DATA_FILE}>
      <h1>浏览到购买的转化过程</h1>
      <section aria-label="浏览到购买的转化过程">
        <svg role="img" viewBox="0 0 120 60">
          <title>浏览到购买的行为阶段</title>
          <rect className="bar-up" x="20" y="12" width="12" height="28" />
          <rect className="bar-down" x="60" y="34" width="12" height="18" />
        </svg>
      </section>
      <p>数据集 {data.dataset_id}；阶段数 {data.datasets?.funnel?.stages?.length ?? 0}</p>
    </main>
  );
}
`
    );

    const passed = await checkRetailArtifactPolicy(projectPath);
    if (passed.status !== 'passed') {
      console.error('[artifact-policy] expected passed policy check');
      console.error(JSON.stringify(passed, null, 2));
      process.exit(1);
    }

    console.log('[artifact-policy] ok');
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[artifact-policy] failed');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
