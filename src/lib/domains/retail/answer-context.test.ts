import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RetailRunPlan } from './workspace';
import { appendRetailAnswerContext } from './answer-context';

const temporaryProjects: string[] = [];

async function createWorkspace(finalData: Record<string, unknown>): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-gate-answer-context-'));
  temporaryProjects.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, 'data_file/final'), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, 'data_file/final/dashboard-data.json'),
    JSON.stringify(finalData),
    'utf8',
  );
  return workspaceRoot;
}

function answerPlan(scope?: { dimension: 'item' | 'category'; value: string }): RetailRunPlan {
  return {
    queryRewrite: { outputIntent: 'answer', analysisFocus: { label: '流量与购买转化' } },
    datasetId: 'retail-demo-answer-context-v1',
    context: scope ? {
      datasetId: 'retail-demo-answer-context-v1',
      entities: [`item:${scope.value}`],
      timeRange: '数据集窗口',
      inherited: false,
      scope: { ...scope, source: 'previous-final-data' },
    } : undefined,
  } as unknown as RetailRunPlan;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => fs.rm(project, { recursive: true, force: true })));
});

describe('appendRetailAnswerContext', () => {
  it('adds dataset, scope, window, and a workbench link to answer-only summaries', async () => {
    const workspaceRoot = await createWorkspace({
      datasetId: 'retail-demo-answer-context-v1',
      window: { start: '2025-12-01', end: '2025-12-03' },
      datasets: {
        funnel: {
          filter: { dimension: 'item', value: '1000009' },
          context_url: '/analytics-workbench?view=drilldown&dataset_id=retail-demo-answer-context-v1&dimension=item&value=1000009',
        },
      },
    });

    const result = await appendRetailAnswerContext({
      summary: '商品 1000009 的购买转化率为 5.05%。',
      workspaceRoot,
      runPlan: answerPlan({ dimension: 'item', value: '1000009' }),
    });

    expect(result).toContain('数据集 retail-demo-answer-context-v1');
    expect(result).toContain('分析内容 流量与购买转化');
    expect(result).toContain('当前查看商品 1000009');
    expect(result).not.toContain('当前查看 item=1000009');
    expect(result).toContain('2025-12-01 ~ 2025-12-03');
    expect(result).toContain('[查看当前分析](/analytics-workbench?view=drilldown');
  });

  it('uses a readable label for category scope', async () => {
    const workspaceRoot = await createWorkspace({
      datasetId: 'retail-demo-answer-context-v1',
      datasets: { funnel: { filter: { dimension: 'category', value: '10011' } } },
    });

    const result = await appendRetailAnswerContext({
      summary: '类目购买转化率为 5.17%。',
      workspaceRoot,
      runPlan: {
        ...answerPlan({ dimension: 'category', value: '10011' }),
        queryRewrite: { outputIntent: 'answer' },
      } as unknown as RetailRunPlan,
    });

    expect(result).toContain('当前查看类目 10011');
    expect(result).not.toContain('当前查看 category=10011');
  });

  it('does not duplicate a link already included by the model', async () => {
    const link = '/analytics-workbench?view=overview&dataset_id=retail-demo-answer-context-v1';
    const workspaceRoot = await createWorkspace({
      datasetId: 'retail-demo-answer-context-v1',
      datasets: { funnel: { context_url: link } },
    });
    const summary = `结论见 [查看当前分析](${link})。`;

    const result = await appendRetailAnswerContext({
      summary,
      workspaceRoot,
      runPlan: answerPlan(),
    });

    expect(result).toBe(summary);
  });

  it('leaves dashboard runs and missing artifacts unchanged', async () => {
    const workspaceRoot = await createWorkspace({ datasetId: 'retail-demo-answer-context-v1', datasets: {} });
    const dashboardPlan = { queryRewrite: { outputIntent: 'dashboard' } } as unknown as RetailRunPlan;

    expect(await appendRetailAnswerContext({ summary: '已生成看板。', workspaceRoot, runPlan: dashboardPlan })).toBe('已生成看板。');
    expect(await appendRetailAnswerContext({ summary: '无法读取数据。', workspaceRoot: '/missing', runPlan: answerPlan() })).toBe('无法读取数据。');
  });
});
