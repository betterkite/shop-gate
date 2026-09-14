import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rewriteRetailQuery } from './query-rewrite';
import { writeInitialRunPlan } from './workspace';

const temporaryProjects: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-gate-routing-'));
  temporaryProjects.push(projectPath);
  return projectPath;
}

async function buildRewrite(query: string, outputIntent: 'dashboard' | 'answer') {
  return rewriteRetailQuery(query, {
    semanticRewriter: async () => ({
      ok: true as const,
      provider: 'test',
      model: 'test-model',
      data: {
        targetCandidates: ['item:1'],
        timeRange: null,
        analysisFocusId: 'price_inventory' as const,
        outputIntent,
        answerOnlyEvidence: outputIntent === 'answer' ? '只做问答' : null,
        broadUniverse: false,
        broadUniverseEvidence: null,
        confidence: 0.95,
      },
    }),
    resolver: async () => ({
      matches: [{ kind: 'item', id: 1, name: '测试商品', confidence: 1 }],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((projectPath) =>
    fs.rm(projectPath, { recursive: true, force: true }),
  ));
});

describe('retail run plan output routing', () => {
  it('persists answer route and disables visualization when chat mode is selected', async () => {
    const projectPath = await createProject();
    const query = 'item:1 的库销比和购买转化率如何？';
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'answer-route',
      instruction: query,
      capabilityId: 'price_inventory',
      capabilitySource: 'manual',
      queryRewrite: await buildRewrite(query, 'dashboard'),
      outputMode: 'chat',
    });

    expect(plan.routeStatus).toBe('answer');
    expect(plan.queryRewrite?.outputIntent).toBe('answer');
    expect(plan.visualization.required).toBe(false);
  });

  it('blocks an unsupported dashboard before execution', async () => {
    const projectPath = await createProject();
    const query = '分析 item:1 的价格弹性，生成经营看板。';
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'unsupported-dashboard',
      instruction: query,
      capabilityId: 'price_inventory',
      capabilitySource: 'manual',
      queryRewrite: await buildRewrite(query, 'dashboard'),
      outputMode: 'act',
    });

    expect(plan.status).toBe('planned');
    expect(plan.routeStatus).toBe('template_not_supported');
    expect(plan.visualization.required).toBe(false);
    expect(plan.visualization.missingMetrics).toContain('price_elasticity');
    expect(plan.expectedArtifacts).toEqual([
      '.data-agent/retail-run-plan.json',
      '.data-agent/events.jsonl',
    ]);
  });

  it('keeps a covered dashboard request executable', async () => {
    const projectPath = await createProject();
    const query = 'item:1 的库存和购买转化率，生成经营看板。';
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'supported-dashboard',
      instruction: query,
      capabilityId: 'price_inventory',
      capabilitySource: 'manual',
      queryRewrite: await buildRewrite(query, 'dashboard'),
      outputMode: 'act',
    });

    expect(plan.routeStatus).toBe('dashboard');
    expect(plan.visualization.required).toBe(true);
  });
});
