import { describe, expect, it, vi } from 'vitest';

import { createCommerceApiGetTool } from './commerce-api';

const TOOL_CONTEXT = {
  runId: 'run-test',
  turn: 1,
  toolCallId: 'call-1',
  operationId: 'test.operation',
  signal: new AbortController().signal,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('commerce_api_get allowlist', () => {
  it('serves allowlisted retail endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }));
    const tool = createCommerceApiGetTool({ fetchImpl });
    const result = await tool.execute!(
      { path: '/api/v1/commerce/funnel', query: { start: '2017-11-25', end: '2017-12-03' } },
      TOOL_CONTEXT,
    );
    expect(result.ok).toBe(true);
    const called = new URL(fetchImpl.mock.calls[0][0].toString());
    expect(called.pathname).toBe('/api/v1/commerce/funnel');
    expect(called.searchParams.get('start')).toBe('2017-11-25');
  });

  it('allows analytics drilldown for follow-up turns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ context: { dimension: 'item', value: '1000000' } }));
    const tool = createCommerceApiGetTool({ fetchImpl });
    const result = await tool.execute!(
      { path: '/api/v1/commerce/analytics/drilldown', query: { dataset_id: 'retail-demo-expanded-v1', dimension: 'item', value: '1000000' } },
      TOOL_CONTEXT,
    );
    expect(result.ok).toBe(true);
    expect(new URL(fetchImpl.mock.calls[0][0].toString()).pathname).toBe('/api/v1/commerce/analytics/drilldown');
  });

  it('denies non-allowlisted paths and traversal', async () => {
    const fetchImpl = vi.fn();
    const tool = createCommerceApiGetTool({ fetchImpl });
    for (const path of [
      '/api/v1/quotes/history/600519',
      '/api/v1/commerce/../admin',
      '/api/v1/commerce/meta?x=1',
      '/api/v2/commerce/meta',
    ]) {
      const result = await tool.execute!({ path, query: {} }, TOOL_CONTEXT);
      expect(result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the per-run request budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const tool = createCommerceApiGetTool({ fetchImpl, maxRequests: 2 });
    await tool.execute!({ path: '/api/v1/commerce/meta', query: {} }, TOOL_CONTEXT);
    await tool.execute!({ path: '/api/v1/commerce/meta', query: {} }, TOOL_CONTEXT);
    const exceeded = await tool.execute!(
      { path: '/api/v1/commerce/meta', query: {} },
      TOOL_CONTEXT,
    );
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) {
      expect(exceeded.error.code).toBe('COMMERCE_API_REQUEST_BUDGET_EXCEEDED');
    }
  });
});
