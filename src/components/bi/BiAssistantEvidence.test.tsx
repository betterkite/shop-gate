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
  it('renders restored definition expansion and distinguishes an out-of-range evidence page', () => {
    expect(renderToStaticMarkup(<BiDefinitionEvidence evidence={source} open />)).toContain('open=""');
    expect(renderToStaticMarkup(<BiDefinitionEvidence evidence={source} open={false} />)).not.toContain('open=""');
    const data = agentResultSchema.parse({ evidence_id: randomUUID(), page: 3, page_size: 20, total: 21,
      query: { dimension: 'store', metrics: ['net_sales'] }, rows: [],
      metadata: { workspace_id: 'account:test', dataset_id: 'data', version: 1,
        range: { start: null, end: null, refund_basis: 'payment' } } });
    const html = renderToStaticMarkup(<BiEvidenceTable data={data} />);
    expect(html).toContain('此页没有记录'); expect(html).not.toContain('此范围没有');
  });
  it('shows real missing-data counts without adding overlapping causes or inventing zeroes', () => {
    const data = agentResultSchema.parse({ evidence_id: randomUUID(), page: 1, page_size: 20, total: 2,
      query: { dimension: 'product', metrics: ['accounted_contribution'] },
      metadata: { workspace_id: 'account:test', dataset_id: 'data', version: 2,
        range: { start: '2026-01-01', end: '2026-01-31', refund_basis: 'payment' } },
      rows: [{ key: 'product1', name: '棉袜', metrics: { accounted_contribution: '121.00' },
        quality: { unknown_cost_lines: 2, unknown_revenue_lines: 2, unknown_refund_lines: 0,
          unknown_expenses: null, unknown_quantity_lines: '3', unknown_attribution_expenses: -1 } },
      { key: '__unattributed__', name: '未归属对象的费用/待映射交易',
        metrics: { accounted_contribution: '-6.00' }, quality: { unknown_quantity_lines: 1 } }] });
    const html = renderToStaticMarkup(<BiEvidenceTable data={data} />);
    expect(html).toContain('缺少商品成本依据的订单明细：2 项');
    expect(html).toContain('缺少付款金额依据的订单明细：2 项');
    expect(html).not.toContain('缺少退款金额依据的订单明细');
    expect(html).not.toContain('尚未核算完整的费用'); expect(html).not.toContain('：4 项');
    expect(html).toContain('不能把这些条数相加'); expect(html).toContain('可能包含待映射交易及费用');
    expect(html).toContain('121.00'); expect(html).toContain('-6.00');
    expect(html).not.toContain('unknown_cost_lines');
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
