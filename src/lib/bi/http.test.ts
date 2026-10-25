import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthorizationError } from '@/lib/auth/authorization';

const mocks = vi.hoisted(() => ({ requireAction: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
import { GET as datasets, POST as create } from '@/app/api/bi/datasets/route';
import { POST as query } from '@/app/api/bi/query/route';
import { GET as catalog } from '@/app/api/bi/catalog/route';
import { GET as template } from '@/app/api/bi/templates/[resource]/route';
import { GET as metadata } from '@/app/api/bi/datasets/[dataset_id]/route';

const SECRET = 'gateway-http-test-not-an-external-credential';
const context = (role = 'owner', actor = 'member-a') => ({
  actorUserId: actor, session: { user: { id: actor } }, projectRole: role, localSystemAdmin: false,
});
const record = { workspace_id: 'account:member-a', dataset_id: 'official', name: '正式导入',
  source_kind: 'import', version: 1, reporting_currency: 'CNY', state: 'active' };
const plan = { dataset_id: 'official', name: '正式导入', source_kind: 'import',
  idempotency_key: 'create-official', confirmed_by_user: true };

function get(path: string, headers: HeadersInit = {}) {
  return new NextRequest(`http://shopgate.test/api/bi/${path}`, { headers });
}
function post(path: string, body: unknown, headers: HeadersInit = {}) {
  return new NextRequest(`http://shopgate.test/api/bi/${path}`, { method: 'POST',
    headers: { origin: 'http://shopgate.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body) });
}
function upstream(data: unknown, status = 200) {
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: status === 200, data }),
    { status, headers: { 'content-type': 'application/json' } }));
}

describe('same-origin BI gateway with real scope issuer', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', SECRET);
    vi.stubEnv('SHOPGATE_COMMERCE_API_URL', 'http://127.0.0.1:8000');
    mocks.requireAction.mockReset().mockResolvedValue(context());
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('fetches selected metadata independently of the directory page and still checks workspace', async () => {
    upstream(record);
    expect((await metadata(get('datasets/official'), { params: Promise.resolve({ dataset_id: 'official' }) })).status).toBe(200);
    expect(mocks.fetch.mock.calls[0][0].href).toBe('http://127.0.0.1:8000/api/v1/bi/datasets/official');
    upstream({ ...record, workspace_id: 'foreign' });
    expect((await metadata(get('datasets/official'), { params: Promise.resolve({ dataset_id: 'official' }) })).status).toBe(503);
    expect((await metadata(get('datasets/official'), { params: Promise.resolve({ dataset_id: '../private' }) })).status).toBe(422);
  });

  it('authorizes directory from actual account and sends no cookies or browser service headers', async () => {
    upstream({ workspace_id: record.workspace_id, rows: [{ ...record, service_token: 'hidden' }],
      total: 1, page: 1, page_size: 20, password: 'hidden' });
    const response = await datasets(get('datasets?page=1', {
      cookie: 'private-session', authorization: 'Bearer browser-forged', 'x-user-id': 'foreign',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { workspace_id: record.workspace_id,
      rows: [record], total: 1, page: 1, page_size: 20 } });
    expect(response.headers.get('cache-control')).toContain('no-store');
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url.href).toBe('http://127.0.0.1:8000/api/v1/bi/datasets?page=1');
    expect(options).toMatchObject({ redirect: 'error', cache: 'no-store' });
    expect(Object.keys(options.headers)).toEqual(['authorization']);
    const claims = JSON.parse(Buffer.from(options.headers.authorization.split(' ')[1].split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ actor_id: 'member-a', workspace_id: record.workspace_id,
      aud: 'shopgate-bi-directory-v1', capabilities: ['datasets.read'] });
    expect(claims).not.toHaveProperty('dataset_id');
  });

  it('creates only explicit confirmed source and strips authorization material from response', async () => {
    upstream({ ...record, notice: '尚未导入', token: 'private-token' });
    const response = await create(post('datasets', plan));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { ...record, notice: '尚未导入' } });
    const options = mocks.fetch.mock.calls[0][1];
    expect(JSON.parse(options.body)).toEqual(plan);
    const claims = JSON.parse(Buffer.from(options.headers.authorization.split(' ')[1].split('.')[0], 'base64url').toString());
    expect(claims.capabilities).toEqual(['datasets.read', 'datasets.manage']);
    expect(mocks.requireAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'commerce.operation.manage' }));
  });

  it.each([
    { confirmed_by_user: false }, { confirmed_by_user: 'true' }, { actor_id: 'forged' },
    { demo_allowed: true }, { url: 'https://foreign.test/' }, { source_kind: 'other' },
  ])('rejects unconfirmed or extra creation fields %o', async (change) => {
    const response = await create(post('datasets', { ...plan, ...change }));
    expect(response.status).toBe(422);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects foreign personal workspace and shared viewer writes', async () => {
    expect((await datasets(get('datasets?workspace_id=account:other'))).status).toBe(404);
    mocks.requireAction.mockResolvedValue(context('viewer'));
    expect((await create(post('datasets', { ...plan, workspace_id: 'project-a' }))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails before fetch when account authorization or local bypass cannot sign', async () => {
    mocks.requireAction.mockRejectedValueOnce(new AuthorizationError('DENIED', 403, 'private-policy'));
    const denied = await datasets(get('datasets'));
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('private-policy');
    mocks.requireAction.mockResolvedValue({ session: null, actorUserId: 'local-system-admin', localSystemAdmin: true });
    expect((await datasets(get('datasets'))).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('never echoes arbitrary authentication/configuration errors', async () => {
    mocks.requireAction.mockRejectedValue(new Error('postgres://secret@host private-cell'));
    const response = await datasets(get('datasets'));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('secret');
    expect(body).not.toContain('private-cell');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['datasets?actor_id=other', 'datasets?page=1&page=2',
    'datasets?upstream=https://foreign.test/', 'datasets?workspace_id=../foreign'])('rejects unsafe URL parameters %s', async (path) => {
    expect((await datasets(get(path))).status).toBe(422);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes and checks bounded media/body before forwarding', async () => {
    expect((await create(post('datasets', plan, { origin: 'https://foreign.test' }))).status).toBe(403);
    expect((await create(post('datasets', plan, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await create(post('datasets', plan, { 'content-encoding': 'gzip' }))).status).toBe(415);
    expect((await create(post('datasets', plan, { 'content-length': '9999999' }))).status).toBe(413);
    expect((await create(post('datasets', { ...plan, name: 'x'.repeat(65536) }))).status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('binds query to exact version and strips extraneous top-level fields', async () => {
    const data = { workspace_id: record.workspace_id, dataset_id: 'official', version: 2,
      accounting_revision: 2, summary: { metrics: { net_sales: '121.00', product_cost: null } },
      rows: [], total: 0, page: 1, page_size: 20 };
    upstream({ ...data, secret: 'private' });
    const response = await query(post('query', { dataset_id: 'official', version: 2,
      query: { dimension: 'store', page: 1 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data });
    const options = mocks.fetch.mock.calls[0][1];
    expect(JSON.parse(options.body)).toEqual({ dimension: 'store', page: 1 });
    const claims = JSON.parse(Buffer.from(options.headers.authorization.split(' ')[1].split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'shopgate-bi-v1', version: 2, dataset_id: 'official', capabilities: ['ledger.read'] });
  });

  it.each([0, true, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])('never signs lossy query version %s', async (version) => {
    expect((await query(post('query', { dataset_id: 'official', version, query: {} }))).status).toBe(422);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([{ workspace_id: 'foreign' }, { dataset_id: 'other' }, { version: 3 }, { accounting_revision: 3 }])('rejects mismatched upstream fact scope %o', async (change) => {
    upstream({ workspace_id: record.workspace_id, dataset_id: 'official', version: 2,
      accounting_revision: 2, ...change });
    expect((await query(post('query', { dataset_id: 'official', version: 2, query: {} }))).status).toBe(503);
  });

  it.each([403, 409, 413, 422, 503, 504])('maps upstream %s without raw response messages', async (status) => {
    upstream({ password: SECRET, query: 'secret-sql' }, status);
    const response = await datasets(get('datasets'));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secret-sql');
  });

  it('redacts fetch errors and refuses redirect following', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('redirect/private DSN password=secret'));
    const response = await datasets(get('datasets'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('password');
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe('error');
  });

  it.each(['file:///private', 'http://user:password@host/', 'http://host/?secret=key', 'https://host/redirect/'])('never accepts invalid service address %s', async (url) => {
    vi.stubEnv('SHOPGATE_COMMERCE_API_URL', url);
    expect((await datasets(get('datasets'))).status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('bounds responses and rejects unparseable service payloads', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    expect((await datasets(get('datasets'))).status).toBe(503);
    mocks.fetch.mockResolvedValueOnce(new Response('private-invalid-json'));
    expect((await datasets(get('datasets'))).status).toBe(503);
  });

  it('downloads fixed CSV route and uses a generated safe filename, not upstream headers', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('\uFEFFtemplate_version,product_id,name\r\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="private-secret.csv"', authorization: SECRET },
    }));
    const response = await template(get('templates/products'), { params: Promise.resolve({ resource: 'products' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="shopgate-products-v1.csv"');
    expect(response.headers.get('authorization')).toBeNull();
    expect(await response.text()).toContain('template_version');
    expect((await template(get('templates/unknown'), { params: Promise.resolve({ resource: '../private' }) })).status).toBe(422);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('gets only authenticated metric/template catalog fields', async () => {
    upstream({ metrics: [{ name: '付款成交金额' }], templates: [], token: SECRET });
    const response = await catalog(get('catalog'));
    expect(await response.json()).toEqual({ success: true, data: { metrics: [{ name: '付款成交金额' }], templates: [] } });
    expect(mocks.fetch.mock.calls[0][0].href).toBe('http://127.0.0.1:8000/api/v1/bi/catalog');
  });
});
