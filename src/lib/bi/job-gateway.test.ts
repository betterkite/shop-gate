import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ action: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.action }));
import { issueJobScope } from './gateway-scope';
import { POST, GET } from '@/app/api/bi/jobs/route';
import { GET as getJob } from '@/app/api/bi/jobs/[job_id]/route';
import { POST as changeJob } from '@/app/api/bi/jobs/[job_id]/[action]/route';
import { GET as download } from '@/app/api/bi/jobs/[job_id]/files/[resource]/route';

const job = { workspace_id: 'account:member-a', dataset_id: 'official', job_id: 'job-a',
  kind: 'preview_import', state: 'queued', base_version: 1, result: {}, stage_label: '等待处理' };
const scope = { dataset_id: 'official', version: 1 };
const context = (role = 'editor') => ({ actorUserId: 'member-a', session: { user: { id: 'member-a' }, session: { id: 'session-a' } }, projectRole: role, localSystemAdmin: false });
const response = (data: unknown) => mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } }));
const post = (data: unknown) => new NextRequest('http://shopgate.test/api/bi/jobs', { method: 'POST', headers: { origin: 'http://shopgate.test', 'content-type': 'application/json' }, body: JSON.stringify(data) });
const get = (extra = '') => new NextRequest(`http://shopgate.test/api/bi/jobs?dataset_id=official&version=1${extra}`);

describe('durable job same-origin gateway', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', 'job-gateway-test-only-not-external');
    vi.stubEnv('SHOPGATE_COMMERCE_API_URL', 'http://127.0.0.1:8000');
    mocks.action.mockReset().mockResolvedValue(context());
    mocks.fetch.mockReset(); vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('signs the actual authenticated session privately and never exchanges fact/directory audiences', async () => {
    const signed = await issueJobScope({ headers: new Headers({ 'x-session-id': 'forged' }), datasetId: 'official', version: 1, write: true });
    const claims = JSON.parse(Buffer.from(signed.token.split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'shopgate-bi-jobs-v1', session_id: 'session-a', actor_id: 'member-a', capabilities: ['jobs.read', 'jobs.manage'] });
    expect(signed).not.toHaveProperty('sessionId');
  });

  it('returns202 with safe metadata and never the persisted session or input', async () => {
    response({ ...job, session_id: 'private-session', payload: { files: ['private'] } });
    const result = await POST(post({ ...scope, kind: 'preview_import', parameters: {}, idempotency_key: 'one', files: [] }));
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({ success: true, data: job });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ kind: 'preview_import', parameters: {}, idempotency_key: 'one', files: [] });
  });

  it.each([{ session_id: 'forged' }, { actor_id: 'forged' }, { state: 'committed' }, { lease_owner: 'forged' }])('rejects self-reported execution identity/state %o', async (extra) => {
    expect((await POST(post({ ...scope, kind: 'preview_import', parameters: {}, idempotency_key: 'one', ...extra }))).status).toBe(422);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects incomplete sessions, foreign workspaces and viewer mutations', async () => {
    mocks.action.mockResolvedValue({ ...context(), session: { user: { id: 'member-a' } } });
    await expect(issueJobScope({ headers: new Headers(), datasetId: 'official', version: 1 })).rejects.toMatchObject({ status: 401 });
    mocks.action.mockResolvedValue(context('viewer'));
    await expect(issueJobScope({ headers: new Headers(), datasetId: 'official', version: 1, workspaceId: 'account:other' })).rejects.toMatchObject({ status: 404 });
    await expect(issueJobScope({ headers: new Headers(), datasetId: 'official', version: 1, workspaceId: 'project-a', write: true })).rejects.toMatchObject({ status: 403 });
  });

  it('lists20-page metadata and reads only scoped job IDs', async () => {
    response({ rows: [job], page: 2, page_size: 20, total: 21 });
    expect((await GET(get('&page=2'))).status).toBe(200);
    expect(mocks.fetch.mock.calls[0][0].href).toBe('http://127.0.0.1:8000/api/v1/bi/jobs?page=2');
    response(job);
    expect((await getJob(get(), { params: Promise.resolve({ job_id: 'job-a' }) })).status).toBe(200);
    response({ ...job, workspace_id: 'foreign' });
    expect((await getJob(get(), { params: Promise.resolve({ job_id: 'job-a' }) })).status).toBe(503);
  });

  it('checks actual immutable job kind before choosing mutation capability for cancellation', async () => {
    response(job); response({ ...job, state: 'cancelled' });
    const result = await changeJob(post(scope), { params: Promise.resolve({ job_id: 'job-a', action: 'cancel' }) });
    expect(result.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'commerce.operation.manage' }));
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({});
    mocks.action.mockClear(); response({ ...job, kind: 'export_standard' }); response({ ...job, kind: 'export_standard', state: 'cancelled' });
    expect((await changeJob(post(scope), { params: Promise.resolve({ job_id: 'job-a', action: 'cancel' }) })).status).toBe(200);
    expect(mocks.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'commerce.operation.manage' }));
  });

  it('only downloads a fixed job resource and hides upstream headers', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('template_version,product_id,name\r\n', { headers: { 'content-type': 'text/csv', authorization: 'private' } }));
    const result = await download(get(), { params: Promise.resolve({ job_id: 'job-a', resource: 'products' }) });
    expect(result.status).toBe(200); expect(result.headers.get('authorization')).toBeNull();
    expect((await download(get(), { params: Promise.resolve({ job_id: '../foreign', resource: 'products' }) })).status).toBe(422);
  });
  it('preserves the expired file status with a safe instruction to re-export', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('private SQL password=never-echo', { status: 410 }));
    const result = await download(get(), { params: Promise.resolve({ job_id: 'job-a', resource: 'products' }) });
    expect(result.status).toBe(410);
    const body = await result.json();
    expect(body.error).toBe('BI_FILE_EXPIRED');
    expect(body.message).toContain('重新导出');
    expect(JSON.stringify(body)).not.toContain('private');
  });
});
