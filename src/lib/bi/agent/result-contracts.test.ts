import { describe, expect, it } from 'vitest';
import { biAgentAnswerSchema, scopedBiAgentQuery, targetDraftInputs } from './result-contracts';
const scope = { module: 'overview', start: '2026-09-01', end: '2026-09-30', channel_ids: ['a'], category: '' };
describe('BI analysis display and query boundaries', () => {
  it('binds a read-only cost scenario to one selected SKU and separates it from a maintenance proposal', () => {
    const question = {dimension:'cost_scenario', hypothetical_unit_cost_cny:'3.0000'};
    expect(scopedBiAgentQuery({module:'costs',sku_ids:['001']}, question)).toMatchObject({...question,sku_ids:['001']});
    for (const page of [{module:'products',sku_ids:['001']},{module:'costs',sku_ids:[]},{module:'costs',sku_ids:['a','b']}]) {
      expect(() => scopedBiAgentQuery(page, question)).toThrow();
    }
    const draft = {kind:'cost_proposal', text:'预览后再确认。', evidence_ids:[], cost_draft:{action:'recalculate',only_missing:false}};
    expect(biAgentAnswerSchema.safeParse(draft).success).toBe(true);
    expect(biAgentAnswerSchema.safeParse({...draft,kind:'answer'}).success).toBe(false);
    expect(biAgentAnswerSchema.safeParse({...draft,cost_draft:{...draft.cost_draft,confirmed_by_user:true}}).success).toBe(false);
  });
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
  it('distinguishes keeping a target, clearing the optional target, and setting a zero amount', () => {
    const base = { kind: 'target_proposal', text: '核对草案', evidence_ids: [] };
    const target = { store_id: 's1', month: '2026-03-01' };
    for (const changes of [{ profit_target: null }, { sales_target: '0.00' }, { profit_target: '-22' }]) {
      expect(biAgentAnswerSchema.parse({ ...base, target_draft: { ...target, ...changes } }).target_draft)
        .toEqual({ ...target, ...changes });
    }
    for (const changes of [{}, { sales_target: '-1' }, { sales_target: '1.123' }, { profit_target: '0', confirmed: true }]) {
      expect(biAgentAnswerSchema.safeParse({ ...base, target_draft: { ...target, ...changes } }).success).toBe(false);
    }
  });
  it('accepts an editable mapping suggestion but never takes a confirmation or an invented business time', () => {
    const base = { kind: 'mapping_proposal', text: '请核对货号。', evidence_ids: [] };
    const draft = { listing_id: '0001', sku_search: '001', multiplier: '0.0001', effective_local: '2024-02-29T08:30' };
    expect(biAgentAnswerSchema.parse({ ...base, mapping_draft: draft }).mapping_draft).toEqual(draft);
    expect(biAgentAnswerSchema.parse({ ...base, mapping_draft: { listing_id: 'l001' } }).mapping_draft)
      .toEqual({ listing_id: 'l001' });
    for (const changes of [{ multiplier: '0.0000' }, { multiplier: '1.00001' }, { effective_local: '2026-02-29T08:30' },
      { listing_id: '__unattributed__' }, { confirmed_by_user: true }, { listing_evidence: { result_id: crypto.randomUUID(), position: 1 } }]) {
      expect(biAgentAnswerSchema.safeParse({ ...base, mapping_draft: { ...draft, ...changes } }).success).toBe(false);
    }
    expect(biAgentAnswerSchema.safeParse({ ...base, kind: 'clarification', mapping_draft: draft }).success).toBe(false);
  });
  it('preserves existing values for ambiguous historical nulls until the operator clears a field', () => {
    const current = { sales_target: '1000.00', profit_target: '200.00' };
    const draft = { store_id: '001', month: '2026-07-01', sales_target: '1200.00', profit_target: null };
    expect(targetDraftInputs(current, draft)).toEqual({ sales: '1200.00', profit: '200.00' });
    expect(targetDraftInputs(current, { ...draft, clear_profit_target: true }).profit).toBe('200.00');
    expect(targetDraftInputs(current, { ...draft, profit_target: '0.00' }).profit).toBe('0.00');
  });
  it('only attaches chart/table views to listed evidence IDs', () => {
    expect(biAgentAnswerSchema.safeParse({ kind: 'clarification', text: '说明', evidence_ids: [],
      views: [{ result_id: 'de305d54-75b4-431b-adb2-eb6b9e546014', kind: 'table', metric: 'net_sales' }] }).success).toBe(false);
  });
});

it('compares refund dates while preserving item filters, reasons and the signed page range', () => {
  const scope = { module: 'refunds', start: '2026-07-01', end: '2026-07-02', sku_ids: ['001'], refund_type: 'return' };
  expect(scopedBiAgentQuery(scope, { dimension: 'refund_event', comparison_refund_basis: 'occurred' }))
    .toMatchObject({ refund_basis: 'occurred', refund_type: 'return', sku_ids: ['001'], start: '2026-07-01' });
  expect(() => scopedBiAgentQuery({ ...scope, module: 'products' }, { comparison_refund_basis: 'occurred' })).toThrow();
});

it('binds report evidence to the selected type, columns, search and ordering', () => {
  const report = { report_type: 'refunds', search: 'extra-', sort: 'key', descending: false, columns: ['key','amount'] };
  const page = { module: 'reports', report, store_ids: ['001'] };
  const evidence = scopedBiAgentQuery(page, { dimension: 'current_report', metrics: ['refund_amount'] });
  expect(evidence.report).toEqual(report);
  expect(evidence.store_ids).toEqual(['001']);
  expect(() => scopedBiAgentQuery(page, { dimension: 'overall' })).toThrow();
  expect(() => scopedBiAgentQuery({ module: 'products' }, {dimension: 'current_report'})).toThrow();
});
