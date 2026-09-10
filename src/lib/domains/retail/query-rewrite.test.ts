import { describe, expect, it } from 'vitest';

import {
  normalizeRetailQuery,
  rankRetailEntityCandidates,
  rewriteRetailQuery,
  stripConversationalEntityReferenceSuffix,
} from './query-rewrite';

describe('retail query rewrite safety', () => {
  it('refuses guaranteed-sales requests', async () => {
    const result = await rewriteRetailQuery('推荐保证卖爆的商品，直接告诉我补哪些', {
      semanticRewriter: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe('refused');
    expect(result.safety.code).toBe('GUARANTEED_SALES_REQUEST');
    expect(result.issues[0].code).toBe('GUARANTEED_SALES_REQUEST');
  });
});

describe('retail query rewrite LLM path', () => {
  const baseSemantics = {
    targetCandidates: [] as string[],
    timeRange: null,
    analysisFocusId: 'funnel' as const,
    outputIntent: 'dashboard' as const,
    answerOnlyEvidence: null,
    broadUniverse: false,
    broadUniverseEvidence: null,
    confidence: 0.9,
  };

  it('pauses when the LLM is unavailable (no keyword fallback)', async () => {
    const result = await rewriteRetailQuery('加购未购买的漏斗哪个环节流失最大', {
      semanticRewriter: async () => ({
        ok: false as const,
        code: 'LLM_NOT_CONFIGURED',
        retryable: false,
      }),
    });
    expect(result.status).toBe('needs_clarification');
    expect(result.issues[0].code).toBe('QUERY_REWRITE_LLM_UNAVAILABLE');
  });

  it('explains invalid provider credentials without falling back to keywords', async () => {
    const result = await rewriteRetailQuery('库销比最差的 10 个商品是哪些？它们的流量转化情况如何？', {
      requestedModel: 'deepseek-v4-flash',
      requestedCapabilityId: 'price_inventory',
      semanticRewriter: async () => ({
        ok: false as const,
        code: 'LLM_HTTP_ERROR',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 401,
        retryable: false,
      }),
    });

    expect(result.status).toBe('needs_clarification');
    expect(result.execution.llm.errorCode).toBe('LLM_AUTH_FAILED');
    expect(result.issues[0].message).toContain('凭据无效或已失效');
  });

  it('requires literal evidence for answer-only intent', async () => {
    let guarded = false;
    const result = await rewriteRetailQuery('分析 item:1000329 的销量', {
      semanticRewriter: async () => ({
        ok: true as const,
        data: {
          ...baseSemantics,
          outputIntent: 'answer' as const,
          answerOnlyEvidence: '这句话没在查询里出现过',
        },
        provider: 'test',
        model: 'test-model',
      }),
    });
    // 非字面证据会被守卫拦下 → LLM 结果整体作废 → 暂停
    guarded = result.status === 'needs_clarification';
    expect(guarded).toBe(true);
  });

  it('resolves item refs through the resolver and reports ready', async () => {
    const result = await rewriteRetailQuery('分析 item:1000329 最近 3 天的销量', {
      semanticRewriter: async () => ({
        ok: true as const,
        data: {
          ...baseSemantics,
          targetCandidates: ['item:1000329'],
          timeRange: {
            label: '最近 3 天',
            value: 3,
            unit: 'day' as const,
            evidence: '最近 3 天',
          },
          analysisFocusId: 'funnel' as const,
          confidence: 0.95,
        },
        provider: 'test',
        model: 'test-model',
      }),
      resolver: async () => ({
        matches: [
          { kind: 'item', id: 1000329, name: '品牌148 百货定制款', confidence: 1.0 },
        ],
      }),
    });
    expect(result.status).toBe('ready');
    expect(result.resolvedEntities[0]).toMatchObject({ kind: 'item', id: 1000329 });
    expect(result.capabilityHint).toBe('traffic_funnel');
  });

  it('treats an explicit window-wide price inventory request as executable', async () => {
    const result = await rewriteRetailQuery('窗口内各价格带的商品分布与库销比风险如何？', {
      requestedCapabilityId: 'price_inventory',
      semanticRewriter: async () => ({
        ok: true as const,
        data: {
          ...baseSemantics,
          analysisFocusId: 'price_inventory' as const,
          timeRange: {
            label: '窗口内',
            value: null,
            unit: 'data_window' as const,
            evidence: '窗口内',
          },
          broadUniverse: false,
          broadUniverseEvidence: null,
        },
        provider: 'test',
        model: 'test-model',
      }),
    });

    expect(result.status).toBe('ready');
    expect(result.broadUniverse).toBe(true);
    expect(result.rewrittenQuery).toContain('全库口径');
    expect(result.execution.llm.guardedFields).toContain('broadUniverse');
  });

  it('does not turn vague product discovery into a whole-catalog run', async () => {
    const result = await rewriteRetailQuery('窗口内有哪些商品值得关注？', {
      requestedCapabilityId: 'price_inventory',
      semanticRewriter: async () => ({
        ok: true as const,
        data: {
          ...baseSemantics,
          analysisFocusId: 'price_inventory' as const,
          broadUniverse: false,
          broadUniverseEvidence: null,
        },
        provider: 'test',
        model: 'test-model',
      }),
    });

    expect(result.status).toBe('needs_clarification');
    expect(result.broadUniverse).toBe(false);
  });
});

describe('retail entity candidate ranking', () => {
  it('prefers exact id match and discloses synthetic fields', () => {
    const ranked = rankRetailEntityCandidates('item:1000329', {
      matches: [
        { kind: 'item', id: 999, name: '别的商品', confidence: 0.6 },
        {
          kind: 'item',
          id: 1000329,
          name: '品牌148 百货定制款',
          confidence: 1.0,
          synthetic_master: true,
        },
      ],
    });
    expect(ranked.selected?.id).toBe(1000329);
    expect(ranked.selected?.syntheticFields).toContain('price');
  });

  it('returns ambiguous top ties below exact-score threshold', () => {
    const ranked = rankRetailEntityCandidates('家居', {
      matches: [
        { kind: 'category', id: 10002, name: '家居类目02', confidence: 0.8 },
        { kind: 'category', id: 10012, name: '家居类目12', confidence: 0.8 },
      ],
    });
    expect(ranked.selected).toBeNull();
    expect(ranked.ambiguous).toHaveLength(2);
  });
});

describe('retail query normalization', () => {
  it('normalizes whitespace and strips conversational entity suffixes', () => {
    expect(normalizeRetailQuery('  分析  item:1000329  ')).toBe('分析 item:1000329');
    expect(stripConversationalEntityReferenceSuffix('这个商品')).toBe('');
    expect(stripConversationalEntityReferenceSuffix('家居类目')).toBe('家居');
  });
});
