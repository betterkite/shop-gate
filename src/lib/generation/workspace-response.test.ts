import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RetailRunPlan } from '@/lib/domains/retail/workspace';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  createRetailDataAgentRegistry,
  RETAIL_AGENT_PROFILE_ID,
} from '@/lib/domains/retail';
import {
  buildWorkspaceProgressMessage,
  WORKSPACE_PROGRESS_STAGE_LABELS,
} from './workspace-response';

function plan(overrides: Partial<RetailRunPlan> = {}): RetailRunPlan {
  return {
    schemaVersion: 1,
    runId: 'run-workspace-response',
    status: 'planned',
    capabilityId: 'traffic_funnel',
    composition: createRetailDataAgentRegistry().resolveCapability(
      RETAIL_AGENT_PROFILE_ID,
      'traffic_funnel',
    ).composition,
    llm: getProjectLlmConfig(),
    question: '这个类目最近转化怎么样',
    entities: ['cat:10051'],
    window: null,
    plannedEntities: { categoryIds: [10051], itemIds: [] },
    timeRange: '数据窗口内最近 9 天',
    dataRequirements: ['GET /api/v1/commerce/funnel', 'GET /api/v1/commerce/funnel/daily'],
    analysisSteps: ['取数', '分析', '生成'],
    visualization: {
      required: true,
      templateId: 'retail-base',
      variantName: '商品经营总览',
      panels: ['经营指标', '流量趋势'],
    },
    expectedArtifacts: ['app/page.tsx'],
    validationRules: ['必须构建通过'],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace response protocol', () => {
  it('stays synchronized with the shared Skills presentation contract', async () => {
    const registry = JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'config', 'pi-agent-skill-capsules.json'),
      'utf8',
    )) as { workspaceResponseContract?: { owner?: string; stageLabels?: string[] } };

    expect(registry.workspaceResponseContract?.owner).toBe('platform');
    expect(registry.workspaceResponseContract?.stageLabels).toEqual(
      [...WORKSPACE_PROGRESS_STAGE_LABELS],
    );
  });

  it('builds the first progress message from the authoritative run plan', () => {
    const content = buildWorkspaceProgressMessage({ stage: 1, runPlan: plan() });

    expect(content).toContain('【进度 1/5】正在理解问题');
    expect(content).toContain('| 维度 | 初步识别 | 状态 |');
    expect(content).toContain('| 业务场景 | 流量与购买转化 | 明确 |');
    expect(content).toContain('| 分析对象 | cat:10051 | 明确 |');
    expect(content).toContain('| 时间范围 | 数据窗口内最近 9 天 | 平台默认 |');
    expect(content).toContain('用户原问句：这个类目最近转化怎么样');
  });

  it('marks an inferred time range as a platform default', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({ question: '分析手机类目', timeRange: '数据窗口内最近 9 天' }),
    });

    expect(content).toContain('| 时间范围 | 数据窗口内最近 9 天 | 平台默认 |');
  });

  it('marks an explicitly requested time window as clear', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({ question: '分析手机类目最近 30 天', timeRange: '最近 30 天' }),
    });

    expect(content).toContain('| 时间范围 | 最近 30 天 | 明确 |');
  });

  it('explains that an uncovered dashboard request continues as an answer', () => {
    const basePlan = plan();
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({
        routeStatus: 'template_not_supported',
        fallbackFrom: 'template_not_supported',
        visualization: { ...basePlan.visualization, required: false },
        routeReason: '当前模板未覆盖 GMV 集中度维度。',
      }),
    });

    expect(content).toContain('看板模板不覆盖，已转为问答');
    expect(content).toContain('已转为问答：当前模板未覆盖 GMV 集中度维度');
    expect(content).not.toContain('已阻断生成');

    const analysisContent = buildWorkspaceProgressMessage({
      stage: 3,
      runPlan: plan({
        routeStatus: 'template_not_supported',
        fallbackFrom: 'template_not_supported',
        queryRewrite: { outputIntent: 'answer' } as RetailRunPlan['queryRewrite'],
        visualization: { ...basePlan.visualization, required: false },
      }),
    });

    expect(analysisContent).toContain('已转为问答并继续取数');
    expect(analysisContent).not.toContain('已停止后续取数和生成');
  });

  it('strips legacy operational prompt suffixes from the visible original question', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({
        question: '分析手机类目\n\n请默认使用中文输出可见的执行过程摘要。\n### 任务拆解',
      }),
    });

    expect(content).toContain('用户原问句：分析手机类目');
    expect(content).not.toContain('### 任务拆解');
  });

  it('stops at clarification instead of claiming that data lookup is starting', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({
        status: 'needs_clarification',
        entities: [],
        clarification: {
          required: true,
          reason: '存在多个同优先级商品或类目',
          missing: ['target'],
          questions: ['请确认具体商品或类目。'],
          confidence: 0.4,
        },
      }),
    });

    expect(content).toContain('先完成必要澄清');
    expect(content).not.toContain('开始核验真实数据和任务合同');
  });

  it('does not claim completion for a failed terminal projection', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      failureReason: '持久预览 HTTP 就绪检查失败',
    });

    expect(content).toContain('【进度 5/5】未完成');
    expect(content).not.toContain('【进度 5/5】已完成');
    expect(content).toContain('持久预览 HTTP 就绪检查失败');
  });

  it('only describes accepted validation and preview in the success projection', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      validationCheckCount: 12,
      previewUrl: 'http://127.0.0.1:3000',
    });

    expect(content).toContain('【进度 5/5】已完成');
    expect(content).toContain('12 项检查完成，无阻断项');
    expect(content).toContain('独立证据验收：通过');
    expect(content).toContain('http://127.0.0.1:3000');
  });

  it('reports validation warnings without claiming that every check passed', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      validationCheckCount: 12,
      validationWarningCount: 2,
      previewUrl: 'http://127.0.0.1:3000',
    });

    expect(content).toContain('12 项检查完成（2 项提示）');
    expect(content).not.toContain('12 项通过');
  });

  it('uses a paused terminal projection for user cancellation', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      cancelledReason: '用户暂停了当前任务',
    });

    expect(content).toContain('【进度 5/5】已暂停');
    expect(content).not.toContain('【进度 5/5】未完成');
  });
});
