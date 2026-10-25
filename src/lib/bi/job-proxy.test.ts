import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/access', () => ({ getAuthSession: vi.fn().mockResolvedValue(null) }));
import { proxy } from '@/proxy';
import { BI_JOB_AUTH_PATH, signBiServiceClaims } from './job-signatures';

function claim() {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'shopgate-bi-job-auth-v1', workspace_id: 'account:member-a', dataset_id: 'official',
    actor_id: 'member-a', session_id: 'session-a', version: 1, job_id: 'job-a', kind: 'confirm_import',
    request_hash: 'a'.repeat(64), phase: 'commit', capabilities: ['job.authorize'], iat: now, exp: now + 25 };
}
describe('one exact private BI authorization proxy gate', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', 'private-job-gate-only-test-secret');
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local');
    vi.stubEnv('SHOPGATE_AUTH_SECRET', 'private-auth-gate-only-test-secret');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('only forwards the exact POST with correct service-purpose HMAC', async () => {
    const headers = { authorization: `Bearer ${signBiServiceClaims(claim())}` };
    expect((await proxy(new NextRequest(`http://localhost${BI_JOB_AUTH_PATH}`, { method: 'POST', headers }))).headers.get('x-middleware-next')).toBe('1');
    expect((await proxy(new NextRequest(`http://localhost${BI_JOB_AUTH_PATH}`, { headers }))).status).toBe(403);
    for (const path of [`${BI_JOB_AUTH_PATH}/extra`, '/api/internal/bi/other']) {
      expect((await proxy(new NextRequest(`http://localhost${path}`, { method: 'POST', headers }))).status).toBe(401);
    }
  });
  it('rejects missing/forged/wrong-purpose headers even when ordinary auth is disabled', async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'disabled');
    for (const token of ['', 'forged.signature', signBiServiceClaims({ ...claim(), aud: 'shopgate-bi-v1' })]) {
      expect((await proxy(new NextRequest(`http://localhost${BI_JOB_AUTH_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-user-id': 'admin' } }))).status).toBe(403);
    }
  });
});
