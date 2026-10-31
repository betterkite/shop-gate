import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dataErrorMessage, DataRequestError, downloadBiFile, fileBase64, readBi, requestDigest, submitDataJob } from './data-browser';
import { StableRequestKeys } from './data-contracts';

const submission = { workspace_id: 'account:a', dataset_id: 'official', version: 2, kind: 'export_standard' as const,
  parameters: { resources: ['products'] } };
const acceptedJob = { ...submission, job_id: 'job-a', base_version: 2, state: 'queued', result: {},
  cancel_requested: false, attempts: 0, error_code: null, expired: false, stage_label: '等待处理',
  created_at: '2026-10-31T00:00:00Z', updated_at: '2026-10-31T00:00:00Z', expires_at: '2026-10-31T01:00:00Z' };

describe('browser data transport never calls models or external data hosts', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses same-origin API and never a browser-visible backend token', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { name: '中文' } })));
    vi.stubGlobal('fetch', fetch);
    expect(await readBi('/api/bi/datasets', z.object({ name: z.string() }), { method: 'POST', body: '{}' })).toEqual({ name: '中文' });
    expect(fetch).toHaveBeenCalledWith('/api/bi/datasets', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-shopgate-request': 'same-origin' } }));
    await expect(readBi('https://external.test/', z.object({}))).rejects.toThrow('当前站点');
  });
  it.each([401, 403, 409, 413, 422, 500])('classifies status%s without echoing raw upstream/private details', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, message: 'private SQL password=secret', request_id: 'forged<script>' }), { status })));
    const error = await readBi('/api/bi/query', z.object({})).catch((problem) => problem);
    expect(error).toBeInstanceOf(DataRequestError); expect(error.status).toBe(status);
    expect(error.message).not.toContain('private'); expect(error.requestId).toBeUndefined();
  });
  it('rejects malformed success payloads and retains safe request identifiers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { count: 'not-number' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, request_id: 'a'.repeat(32) + '-123' }), { status: 503 })));
    await expect(readBi('/api/bi/jobs', z.object({ count: z.number() }))).rejects.toMatchObject({ status: 502 });
    const error = await readBi('/api/bi/jobs', z.object({})).catch((problem) => problem);
    expect(dataErrorMessage(error)).toContain('请求编号');
  });
  it('round-trips binary BOM/Chinese CSV into strict base64 without editing source text', async () => {
    const input = new TextEncoder().encode('\uFEFFtemplate_version,product_id,name\r\n1,0001,商品\r\n');
    const file = new File([input], 'products.csv');
    const encoded = await fileBase64(file);
    expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(input);
    await expect(fileBase64(new File([], 'empty.csv'))).rejects.toThrow('非空');
  });
  it('stable request digests distinguish contents and bind workspace/dataset/version', async () => {
    const input = { workspace_id: 'a', dataset_id: 'demo', version: 1, kind: 'preview_import', parameters: {} };
    const digest = await requestDigest(input);
    expect(await requestDigest(input)).toBe(digest);
    expect(await requestDigest({ ...input, version: 2 })).not.toBe(digest);
    expect(await requestDigest({ ...input, workspace_id: 'b' })).not.toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('retries uncertain submissions once, then allows another deliberate export with identical options', async () => {
    const response = (jobId: string) => new Response(JSON.stringify({ success: true, data: { ...acceptedJob, job_id: jobId } }));
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('connection lost after server accepted'))
      .mockResolvedValueOnce(response('first-export')).mockResolvedValueOnce(response('new-export'));
    vi.stubGlobal('fetch', fetch);
    const keys = new StableRequestKeys();
    await expect(submitDataJob(submission, keys)).rejects.toThrow('connection lost');
    expect((await submitDataJob(submission, keys)).job_id).toBe('first-export');
    expect((await submitDataJob(submission, keys)).job_id).toBe('new-export');
    const requests = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(requests[0].idempotency_key).toBe(requests[1].idempotency_key);
    expect(requests[2].idempotency_key).not.toBe(requests[1].idempotency_key);
    for (const request of requests) expect({ ...request, idempotency_key: undefined }).toEqual({ ...submission, idempotency_key: undefined });
  });
  it('does not submit after switching data scope while the request digest is prepared', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(submitDataJob(submission, new StableRequestKeys(), () => false)).rejects.toThrow('已切换');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ workspace_id: 'foreign' }, { dataset_id: 'foreign' }, { base_version: 1 }, { kind: 'confirm_import' }, { state: 'invalid' }])(
    'retains the uncertain key when an acknowledgement is malformed or belongs to a different scope: %j', async (change) => {
      const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...acceptedJob, ...change } })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: acceptedJob })));
      vi.stubGlobal('fetch', fetch);
      const keys = new StableRequestKeys();
      await expect(submitDataJob(submission, keys)).rejects.toMatchObject({ status: 502 });
      await submitDataJob(submission, keys);
      expect(JSON.parse(fetch.mock.calls[0][1].body).idempotency_key).toBe(JSON.parse(fetch.mock.calls[1][1].body).idempotency_key);
    });
  it('never saves an authentication/error HTML page as a downloaded CSV', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('login page', { status: 401 }))
      .mockResolvedValueOnce(new Response('login page', { headers: { 'content-type': 'text/html' } })));
    await expect(downloadBiFile('/api/bi/templates/orders', 'shopgate-orders-v1.csv')).rejects.toMatchObject({ status: 401 });
    await expect(downloadBiFile('/api/bi/templates/orders', 'shopgate-orders-v1.csv')).rejects.toMatchObject({ status: 502 });
    await expect(downloadBiFile('https://foreign.test/', 'shopgate-orders-v1.csv')).rejects.toThrow('无效');
  });
  it('explains expired exports without saving an empty or error file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream error', { status: 410 })));
    const failure = await downloadBiFile('/api/bi/jobs/job-a/files/products', 'shopgate-products-v1.csv').catch((error) => error);
    expect(failure).toMatchObject({ status: 410 });
    expect(failure.message).toContain('重新导出');
    expect(failure.message).toContain('经营数据和任务记录仍保留');
    expect(failure.message).not.toContain('private');
  });
});
