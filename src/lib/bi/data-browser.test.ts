import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dataErrorMessage, DataRequestError, downloadBiFile, fileBase64, readBi, requestDigest } from './data-browser';

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
  it('never saves an authentication/error HTML page as a downloaded CSV', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('login page', { status: 401 }))
      .mockResolvedValueOnce(new Response('login page', { headers: { 'content-type': 'text/html' } })));
    await expect(downloadBiFile('/api/bi/templates/orders', 'shopgate-orders-v1.csv')).rejects.toMatchObject({ status: 401 });
    await expect(downloadBiFile('/api/bi/templates/orders', 'shopgate-orders-v1.csv')).rejects.toMatchObject({ status: 502 });
    await expect(downloadBiFile('https://foreign.test/', 'shopgate-orders-v1.csv')).rejects.toThrow('无效');
  });
});
