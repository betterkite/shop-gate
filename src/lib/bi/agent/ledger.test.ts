import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('./authorization', () => ({ recheckBiAgentSession: mocks.authorize }));
import { readBiAgentLedger, resolveBiAgentPage } from './ledger';
import { biAgentPageScopeSchema } from './contracts';
const authority = { actorId: 'member', sessionId: 'actual-private-session', workspaceId: 'account:member' };
const payload = (change = {}) => ({ success: true, data: { workspace_id: authority.workspaceId,
  dataset_id: 'official', version: 2, accounting_revision: 2,
  range: { start: '2026-09-01', end: '2026-09-30', refund_basis: 'payment' }, ...change } });
const fetchMock = vi.fn();
describe('BI assistant scoped ledger connection', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPGATE_COMMERCE_API_URL', 'http://127.0.0.1:9876');
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', 'owned-ledger-signing-only-test-secret');
    vi.stubGlobal('fetch', fetchMock);
    mocks.authorize.mockReset().mockResolvedValue(authority);
    fetchMock.mockReset().mockImplementation(async () => Response.json(payload()));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('resolves dates from the same ledger and signs only read capability without a cookie/session', async () => {
    const result = await resolveBiAgentPage(authority, 'official', 2, biAgentPageScopeSchema.parse({ module: 'overview' }));
    expect(result).toMatchObject({ start: '2026-09-01', end: '2026-09-30' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe('http://127.0.0.1:9876/api/v1/bi/query');
    const claims = JSON.parse(Buffer.from(options.headers.authorization.slice(7).split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'shopgate-bi-v1', actor_id: 'member', version: 2, capabilities: ['ledger.read'] });
    expect(JSON.stringify(options)).not.toContain(authority.sessionId);
    expect(JSON.parse(options.body)).toMatchObject({ dimension: 'overall', page_size: 20 });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
  });
  it.each([{ workspace_id: 'account:other' }, { dataset_id: 'other' }, { version: 3 }, { accounting_revision: 1 }])
    ('rejects scope/version substitution %o', async (change) => {
      fetchMock.mockResolvedValue(Response.json(payload(change)));
      await expect(readBiAgentLedger(authority, 'official', 2, {})).rejects.toThrow('different scope or version');
    });
  it('rejects access revoked while a query was in flight', async () => {
    mocks.authorize.mockResolvedValueOnce(authority).mockRejectedValueOnce(new Error('revoked'));
    await expect(readBiAgentLedger(authority, 'official', 2, {})).rejects.toThrow('revoked');
  });
  it('preserves unknown dates for an empty dataset rather than inventing a period', async () => {
    fetchMock.mockResolvedValue(Response.json(payload({ range: { start: null, end: null, refund_basis: 'payment' } })));
    expect(await resolveBiAgentPage(authority, 'official', 2, biAgentPageScopeSchema.parse({ module: 'overview' })))
      .toMatchObject({ start: undefined, end: undefined });
  });
  it('maps a stale ledger version to a retryable conflict without exposing upstream text', async () => {
    fetchMock.mockResolvedValue(new Response('private upstream SQL', { status: 409 }));
    await expect(readBiAgentLedger(authority, 'official', 2, {})).rejects.toMatchObject({ code: 'BI_AGENT_CONFLICT', status: 409 });
  });
});

describe('BI ledger cancellation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('does not authorize or fetch an already cancelled request', async () => {
    mocks.authorize.mockReset(); const controller = new AbortController(); controller.abort();
    await expect(readBiAgentLedger(authority, 'official', 2, {}, controller.signal)).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('aborts the in-flight transport when the owning run is cancelled', async () => {
    vi.stubEnv('SHOPGATE_COMMERCE_API_URL', 'http://127.0.0.1:9876');
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', 'owned-ledger-signing-only-test-secret');
    mocks.authorize.mockReset().mockResolvedValue(authority);
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const pending = new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      controller.abort(); return pending;
    }));
    await expect(readBiAgentLedger(authority, 'official', 2, {}, controller.signal)).rejects.toThrow();
  });
});
