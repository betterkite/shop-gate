import React from 'react';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BiDefinitionEvidence, BiEvidenceTable } from './BiAssistantEvidence';
import { agentAnswerSchema, agentResultSchema } from '@/lib/bi/agent/browser';
import { biAgentAnswerSchema } from '@/lib/bi/agent/result-contracts';

const source = { source_id: randomUUID(), digest: 'a'.repeat(64), recorded_at: '2026-11-07T00:00:00.000Z',
  metrics: [{ id: 'net_sales', name: '净销售额', unit: '元', formula: '付款成交金额 − 退款金额',
    missing_policy: '缺少金额时保留未知', dimensions: ['overall', 'store'], source: '订单与退款', aggregation: '相加' }] };
describe('readable BI assistant evidence', () => {
  it('shows original definitions with Chinese scope and escapes source text', () => {
    const html = renderToStaticMarkup(<BiDefinitionEvidence evidence={{ ...source,
      metrics: [{ ...source.metrics[0], source: '<script>alert(1)</script>' }] }} />);
    expect(html).toContain('查看指标说明依据'); expect(html).toContain('付款成交金额 − 退款金额');
    expect(html).toContain('全部范围、店铺'); expect(html).toContain('缺少金额时保留未知');
    expect(html).not.toContain('<script>'); expect(html).not.toContain(source.source_id);
  });
  it('keeps empty results readable without an empty wide table and preserves populated figures', () => {
    const data = agentResultSchema.parse({ evidence_id: randomUUID(), page: 1, page_size: 20, total: 0,
      query: { dimension: 'store', metrics: ['contribution_margin'] },
      metadata: { workspace_id: 'account:test', dataset_id: 'test-data', version: 1,
        range: { start: '2026-01-01', end: '2026-01-31', refund_basis: 'payment' } }, rows: [] });
    const empty = renderToStaticMarkup(<BiEvidenceTable data={data} />);
    expect(empty).toContain('此范围没有符合条件的记录'); expect(empty).not.toContain('<table');
    const populated = renderToStaticMarkup(<BiEvidenceTable data={{ ...data, total: 1,
      rows: [{ key: 'store1', name: '测试店铺', metrics: { contribution_margin: '0.91666667' }, quality: {} }] }} />);
    expect(populated).toContain('测试店铺'); expect(populated).toContain('91.67%'); expect(populated).toContain('<table');
  });
  it('requires matching saved definitions and retains the separate factual evidence requirement', () => {
    const answer = { kind: 'definition', text: '净销售额的含义', evidence_ids: [],
      definition_source_id: source.source_id, definition_ids: ['net_sales'] };
    expect(agentAnswerSchema.safeParse({ status: 'completed', answer, definitions: source }).success).toBe(true);
    for (const definitions of [null, { ...source, source_id: randomUUID() }, { ...source, metrics: [] }]) {
      expect(agentAnswerSchema.safeParse({ status: 'completed', answer, definitions }).success).toBe(false);
    }
    expect(biAgentAnswerSchema.safeParse({ ...answer, kind: 'answer' }).success).toBe(false);
    expect(biAgentAnswerSchema.safeParse({ kind: 'definition', text: '无来源', evidence_ids: [] }).success).toBe(false);
    expect(biAgentAnswerSchema.safeParse({ ...answer, evidence_ids: [randomUUID()] }).success).toBe(false);
    expect(biAgentAnswerSchema.safeParse({ kind: 'answer', text: '历史答案', evidence_ids: [randomUUID()] }).success).toBe(true);
  });
});
