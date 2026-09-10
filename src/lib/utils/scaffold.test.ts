import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreRetailDashboardTemplate, scaffoldBasicNextApp } from './scaffold';
import {
  retailBaseDashboardCssTemplate,
  retailBaseDashboardPageTemplate,
  retailCatalogPageTemplate,
  retailDailyBriefPageTemplate,
  retailFunnelPageTemplate,
  retailPriceInventoryPageTemplate,
} from './retail-scaffold-templates';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shopgate-scaffold-'));
  temporaryProjects.push(projectPath);
  await fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('restoreRetailDashboardTemplate', () => {
  it('keeps retail scenario templates as continuous workbenches with readable metrics and charts', () => {
    const templates = [
      {
        name: 'retail-base',
        page: retailBaseDashboardPageTemplate(),
        css: retailBaseDashboardCssTemplate(),
        required: ['data-visual-language="retail-workbench"', '零售经营看板', '数据集覆盖'],
      },
      {
        name: 'retail-funnel',
        page: retailFunnelPageTemplate(),
        css: retailBaseDashboardCssTemplate(),
        required: ['流量与转化漏斗', '行为漏斗', '页面浏览量（PV）'],
      },
      {
        name: 'retail-catalog',
        page: retailCatalogPageTemplate(),
        css: retailBaseDashboardCssTemplate(),
        required: ['类目与商品结构', '成交总额（GMV）排名', '高浏览低购买类目'],
      },
      {
        name: 'retail-price-inventory',
        page: retailPriceInventoryPageTemplate(),
        css: retailBaseDashboardCssTemplate(),
        required: ['电商经营 BI 看板', '价格区间分布（商品价格）', '库存健康度'],
      },
      {
        name: 'retail-daily-brief',
        page: retailDailyBriefPageTemplate(),
        css: retailBaseDashboardCssTemplate(),
        required: ['经营日报（当日观察）', '成交总额（GMV）', '分日流量与转化'],
      },
    ];

    for (const template of templates) {
      expect(template.page, template.name).toContain('data-visual-language="retail-workbench"');
      for (const signal of template.required) {
        expect(template.page, `${template.name}: ${signal}`).toContain(signal);
      }
      for (const hiddenEvidenceDetail of ['数据信源渠道', '技术证据', '行情源：', 'evidence/sources.json', '场景模板', '必备组件']) {
        expect(template.page, `${template.name}: ${hiddenEvidenceDetail}`).not.toContain(hiddenEvidenceDetail);
      }
    }
  });

  it('keeps the retail stylesheet responsive and free of floating card-grid drift', () => {
    const css = retailBaseDashboardCssTemplate();
    expect(css).toContain('data-visual-language="retail-workbench"');
    expect(css).toContain('max-width: 100%');
    expect(css).toContain('min-width: 0');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('width: 100vw');
  });

  it('replaces an invalid Agent page with the platform technical dashboard', async () => {
    const projectPath = await createProject();
    await Promise.all([
      fs.writeFile(
        path.join(projectPath, '.data-agent', 'retail-run-plan.json'),
        JSON.stringify({
          status: 'planned',
          capabilityId: 'technical_analysis',
          symbols: ['600519'],
          visualization: { templateId: 'technical-timing' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'),
        JSON.stringify({
          runId: 'restore-test',
          window: { start: '2017-11-25', end: '2017-12-03' },
          plannedEntities: { categoryIds: [], itemIds: [] },
          visualization: { template_id: 'retail-base' },
        })
      ),
      fs.writeFile(
        path.join(projectPath, 'app', 'page.tsx'),
        'export default function Page(){ return <main>TradingPlanPanel 买入区间 止损 目标价</main> }\n'
      ),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), 'body{}\n'),
    ]);

    await restoreRetailDashboardTemplate(projectPath);

    const [page, css] = await Promise.all([
      fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8'),
    ]);
    expect(page).toContain('data-visual-language="retail-workbench"');
    expect(page).toContain('零售经营看板');
    expect(page).toContain('数据集覆盖');
    expect(page).toContain('synthetic-badge');
    expect(page).not.toContain('TradingPlanPanel');
    expect(page).not.toContain('买入区间');
    expect(css).toContain('.dashboard-shell');
    expect(css).toContain('.dashboard-shell[data-visual-language="retail-workbench"] .synthetic-badge');
    expect(css).toContain('border-radius: 999px');
  });

  it('scaffolds a continuous retail workbench instead of a card-grid default', async () => {
    const projectPath = await createProject();

    await scaffoldBasicNextApp(projectPath, 'continuous-workbench-project');

    const [page, css, nextConfig, buildScript, devScript] = await Promise.all([
      fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8'),
      fs.readFile(path.join(projectPath, 'next.config.js'), 'utf8'),
      fs.readFile(path.join(projectPath, 'scripts', 'run-build.js'), 'utf8'),
      fs.readFile(path.join(projectPath, 'scripts', 'run-dev.js'), 'utf8'),
    ]);
    expect(page).toContain('data-visual-language="retail-workbench"');
    expect(page).toContain('零售经营看板');
    expect(page).toContain('synthetic-badge');
    expect(page).toContain('return <span className="synthetic-badge"');
    expect(page).not.toContain("return '<span class=\"synthetic-badge\"");
    expect(page).toContain('数据集覆盖');
    expect(css).toContain('.dashboard-shell[data-visual-language="retail-workbench"] .synthetic-badge');
    expect(css).toContain('.dashboard-shell[data-visual-language="retail-workbench"] .dense-table');
    expect(nextConfig).toContain('outputFileTracingRoot: projectRoot');
    expect(nextConfig).toContain('root: projectRoot');
    expect(nextConfig).not.toContain('outputFileTracingRoot: workspaceRoot');
    expect(nextConfig).not.toContain('root: workspaceRoot');
    expect(buildScript).toContain("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']");
    expect(devScript).toContain("defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack']");
  });

  it('keeps an existing page and stylesheet during non-destructive scaffolding', async () => {
    const projectPath = await createProject();
    const page = 'export default function Page(){ return <main>custom dashboard</main> }\n';
    const css = '.custom-dashboard { color: rebeccapurple; }\n';
    await Promise.all([
      fs.writeFile(path.join(projectPath, 'app', 'page.tsx'), page),
      fs.writeFile(path.join(projectPath, 'app', 'globals.css'), css),
    ]);

    await scaffoldBasicNextApp(projectPath, 'non-destructive-project');

    await expect(fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
    await expect(fs.readFile(path.join(projectPath, 'app', 'globals.css'), 'utf8')).resolves.toBe(css);
  });

  it('does not rewrite an unchanged package.json during repeated scaffolding', async () => {
    const projectPath = await createProject();
    const packageJsonPath = path.join(projectPath, 'package.json');

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');
    const contents = await fs.readFile(packageJsonPath, 'utf8');
    const sentinel = new Date('2026-01-01T00:00:00.000Z');
    await fs.utimes(packageJsonPath, sentinel, sentinel);
    const before = await fs.stat(packageJsonPath);

    await scaffoldBasicNextApp(projectPath, 'idempotent-project');

    const after = await fs.stat(packageJsonPath);
    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(contents);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('normalizes the platform TypeScript config before read-only sandbox execution', async () => {
    const projectPath = await createProject();
    const tsconfigPath = path.join(projectPath, 'tsconfig.json');
    await fs.writeFile(tsconfigPath, JSON.stringify({
      compilerOptions: { jsx: 'preserve', strict: true },
      include: ['next-env.d.ts', '**/*.tsx'],
    }));

    await scaffoldBasicNextApp(projectPath, 'sandbox-ready-project');

    const config = JSON.parse(await fs.readFile(tsconfigPath, 'utf8'));
    const nextEnv = await fs.readFile(path.join(projectPath, 'next-env.d.ts'), 'utf8');
    expect(config.compilerOptions).toMatchObject({
      jsx: 'react-jsx',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      plugins: [{ name: 'next' }],
      strict: true,
    });
    expect(config.include).toEqual(expect.arrayContaining([
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
      '**/*.mts',
    ]));
    expect(nextEnv).toContain('import "./.next/types/routes.d.ts";');
    expect(nextEnv).not.toContain('next/navigation-types/navigation');
  });
});
