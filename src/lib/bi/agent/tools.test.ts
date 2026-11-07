import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), catalog: vi.fn(), collect: vi.fn(), inspect: vi.fn(), save: vi.fn(), fence: vi.fn() }));
vi.mock('./requests', () => ({ authorizeBiAgentRun: mocks.authorize }));
vi.mock('./metric-sources', () => ({ collectBiAgentMetricSource: mocks.catalog }));
vi.mock('./results', () => ({ collectBiAgentResult: mocks.collect, inspectBiAgentResultPage: mocks.inspect,
  saveBiAgentAnswer: mocks.save, assertBiAgentResultFence: mocks.fence }));
import { createBiAgentTools } from './tools';
import { biAgentQuerySchema } from './result-contracts';
import { BI_RESULT_READING_GUIDE } from './presentation';
const fence = { runId: 'owned-run', leaseOwner: 'owned-worker', fencingToken: 1, workspaceFencingToken: 2 };
const context = { runId: fence.runId, turn: 1, toolCallId: 'call', operationId: 'owned-operation', signal: new AbortController().signal };
describe('BI assistant controlled tool registration', () => {
  beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.fence.mockResolvedValue(undefined); });
  it('registers only dictionary, ledger, saved paging and structured answer, with JSON input schemas', () => {
    const tools = createBiAgentTools(fence);
    expect(tools.map((t) => t.name)).toEqual(['metric_dictionary', 'query_ledger', 'read_result_page', 'submit_answer']);
    for (const tool of tools) { expect(tool.effect).toBe('read'); expect(tool.inputSchema.type).toBe('object'); }
    expect(tools.filter((t) => t.terminal).map((t) => t.name)).toEqual(['submit_answer']);
  });
  it('passes the framework operation ID and abort signal to complete result collection', async () => {
    mocks.collect.mockResolvedValue({ evidence_id: 'opaque', total: 25, preview: [{ key: 's', name: '店铺',
      metrics: { contribution_margin: '0.91666667', product_cost: null }, quality: {} }],
      metadata: { summary: { metrics: { contribution_margin: '0.91666667' }, quality: {} } }, complete: true });
    expect(await createBiAgentTools(fence)[1].execute({ dimension: 'store' }, context)).toMatchObject({ ok: true, data: { total: 25,
      display_summary: { contribution_margin: '91.67%' }, display_preview: [{ key: 's', metrics: { contribution_margin: '91.67%', product_cost: '待核算' } }] } });
    expect(mocks.collect).toHaveBeenCalledWith(fence, 'owned-operation', { dimension: 'store' }, context.signal, {});
  });
  it('formats subsequent evidence pages by the same rules without changing their raw decimals', async () => {
    mocks.inspect.mockResolvedValue({ rows: [{ key: 'last', name: '末项', metrics: { contribution_margin: '-0.91666667' }, quality: {} }] });
    expect(await createBiAgentTools(fence)[2].execute({ evidence_id: 'de305d54-75b4-431b-adb2-eb6b9e546014', page: 2 }, context))
      .toMatchObject({ ok: true, data: { rows: [{ metrics: { contribution_margin: '-0.91666667' } }],
        display_rows: [{ metrics: { contribution_margin: '-91.67%' } }] } });
  });
  it('labels unassigned evidence and exposes supported actions without altering the total', async () => {
    const row = { key: '__unattributed__', name: '未归属项',
      metrics: { net_sales: '69090.60', accounted_contribution: '-4615.44' },
      quality: { unknown_cost_lines: 51, unknown_expenses: 29, unknown_quantity_lines: null } };
    const metadata = { summary: { metrics: { accounted_contribution: '783245.88' }, quality: {} } };
    mocks.collect.mockResolvedValue({ evidence_id: 'opaque', total: 363, preview: [row], metadata, complete: true });
    const result = await createBiAgentTools(fence)[1].execute({ dimension: 'product' }, context);
    expect(result).toMatchObject({ ok: true, data: { total: 363, metadata, preview: [row],
      reading_guide: BI_RESULT_READING_GUIDE, display_summary: { accounted_contribution: '783,245.88' },
      display_preview: [{ is_unattributed: true, quality: [
        { key: 'unknown_cost_lines', label: '缺少商品成本依据的订单明细', count: 51 },
        { key: 'unknown_expenses', label: '尚未核算完整的费用', count: 29 },
      ] }] } });
    for (const sort of BI_RESULT_READING_GUIDE.allowed_sort_fields) {
      expect(biAgentQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(biAgentQuerySchema.safeParse({ sort: 'unknown_cost_lines' }).success).toBe(false);
    expect(biAgentQuerySchema.safeParse({ contribution_positive: true }).success).toBe(false);
    mocks.inspect.mockResolvedValue({ rows: [row] });
    expect(await createBiAgentTools(fence)[2].execute({ evidence_id: 'de305d54-75b4-431b-adb2-eb6b9e546014', page: 19 }, context))
      .toMatchObject({ ok: true, data: { reading_guide: BI_RESULT_READING_GUIDE,
        display_rows: [{ is_unattributed: true, metrics: { net_sales: '69,090.60' } }] } });
  });
  it('keeps full display text out of public terminal receipts', async () => {
    mocks.save.mockResolvedValue({ kind: 'answer', text: 'User private answer', evidence_ids: ['owned-evidence'] });
    const result = await createBiAgentTools(fence)[3].execute({}, context);
    expect(result).toEqual({ ok: true, data: { accepted: true, kind: 'answer', evidence_ids: ['owned-evidence'] } });
    expect(JSON.stringify(result)).not.toContain('private answer');
  });
  it('never leaks internal SQL/provider errors and does not execute after a fence failure', async () => {
    mocks.fence.mockRejectedValue(new Error('SELECT private_column FROM private_table'));
    const result = await createBiAgentTools(fence)[1].execute({}, context);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private_column'); expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('stops before tool work on cancellation or a mismatched physical run', async () => {
    const aborted = new AbortController(); aborted.abort();
    await expect(createBiAgentTools(fence)[1].execute({}, { ...context, signal: aborted.signal })).rejects.toThrow();
    expect((await createBiAgentTools(fence)[1].execute({}, { ...context, runId: 'other' })).ok).toBe(false);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
