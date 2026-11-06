import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), catalog: vi.fn(), collect: vi.fn(), inspect: vi.fn(), save: vi.fn(), fence: vi.fn() }));
vi.mock('./requests', () => ({ authorizeBiAgentRun: mocks.authorize }));
vi.mock('./ledger', () => ({ readBiAgentMetricCatalog: mocks.catalog }));
vi.mock('./results', () => ({ collectBiAgentResult: mocks.collect, inspectBiAgentResultPage: mocks.inspect,
  saveBiAgentAnswer: mocks.save, assertBiAgentResultFence: mocks.fence }));
import { createBiAgentTools } from './tools';
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
    mocks.collect.mockResolvedValue({ evidence_id: 'opaque', total: 25, preview: [], complete: true });
    expect(await createBiAgentTools(fence)[1].execute({ dimension: 'store' }, context)).toMatchObject({ ok: true, data: { total: 25 } });
    expect(mocks.collect).toHaveBeenCalledWith(fence, 'owned-operation', { dimension: 'store' }, context.signal, {});
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
