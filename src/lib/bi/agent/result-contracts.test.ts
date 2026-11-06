import { describe, expect, it } from 'vitest';
import { biAgentAnswerSchema, scopedBiAgentQuery } from './result-contracts';
const scope = { module: 'overview', start: '2026-09-01', end: '2026-09-30', channel_ids: ['a'], category: '' };
describe('BI analysis display and query boundaries', () => {
  it('inherits all page filters and never accepts a model-selected identity or raw formula', () => {
    expect(scopedBiAgentQuery(scope, { dimension: 'product' })).toMatchObject({ channel_ids: ['a'], category: '', start: '2026-09-01' });
    for (const bad of [{ workspace_id: 'someone' }, { sql: 'SELECT *' }, { metrics: ['made_up_profit'] }, { store_ids: ['outside'] }]) {
      expect(() => scopedBiAgentQuery(scope, bad)).toThrow();
    }
  });
  it('allows an explicit valid comparison period without changing selected entities', () => {
    expect(scopedBiAgentQuery(scope, { period: { start: '2026-08-01', end: '2026-08-31', reason: '与上月比较' } }))
      .toMatchObject({ start: '2026-08-01', end: '2026-08-31', channel_ids: ['a'], category: '' });
    for (const start of ['2026-02-30', '2026-09-30']) expect(() => scopedBiAgentQuery(scope,
      { period: { start, end: '2026-08-31', reason: '与上月比较' } })).toThrow();
  });
  it('requires facts to cite evidence and rejects hidden reasoning and arbitrary UI code', () => {
    expect(biAgentAnswerSchema.safeParse({ kind: 'answer', text: '销售额164元', evidence_ids: [] }).success).toBe(false);
    for (const extra of [{ reasoning: 'private' }, { html: '<script />' }]) expect(biAgentAnswerSchema.safeParse({
      kind: 'clarification', text: '请说明比较周期', evidence_ids: [], ...extra }).success).toBe(false);
    expect(biAgentAnswerSchema.parse({ kind: 'data_unavailable', text: '当前范围没有完整成本记录。', evidence_ids: [] }).kind)
      .toBe('data_unavailable');
  });
  it('resolves the previous inclusive window instead of trusting model date arithmetic', () => {
    expect(scopedBiAgentQuery({ ...scope, start: '2026-05-03', end: '2026-07-02' }, { period: 'previous' }))
      .toMatchObject({ start: '2026-03-03', end: '2026-05-02', channel_ids: ['a'], category: '' });
    expect(scopedBiAgentQuery({ ...scope, start: '2024-03-01', end: '2024-03-01' }, { period: 'previous' }))
      .toMatchObject({ start: '2024-02-29', end: '2024-02-29' });
    for (const page of [{ module: 'overview' }, { ...scope, start: '0001-01-01', end: '0001-01-01' }]) {
      expect(() => scopedBiAgentQuery(page, { period: 'previous' })).toThrow();
    }
  });
  it('only attaches chart/table views to listed evidence IDs', () => {
    expect(biAgentAnswerSchema.safeParse({ kind: 'clarification', text: '说明', evidence_ids: [],
      views: [{ result_id: 'de305d54-75b4-431b-adb2-eb6b9e546014', kind: 'table', metric: 'net_sales' }] }).success).toBe(false);
  });
});
