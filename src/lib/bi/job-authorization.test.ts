import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ session: vi.fn(), policy: vi.fn(), role: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { authSession: { findUnique: mocks.session } } }));
vi.mock('@/lib/auth/action', () => ({ requireAction: vi.fn(), PrismaPermissionPolicyRepository: class {
  resolvePolicy = mocks.policy;
} }));
vi.mock('@/lib/auth/authorization', async (original) => ({
  ...await original<typeof import('@/lib/auth/authorization')>(), projectRoleForUser: mocks.role,
}));

import { requireBiJobAuthorization } from './job-authorization';
import { signBiServiceClaims, verifyJobAuthorizationRequest, type JobAuthorizationClaim } from './job-signatures';
import { POST } from '@/app/api/internal/bi/job-authorization/route';

const NOW = new Date('2026-10-25T08:00:00Z');
const claims = (extra = {}): JobAuthorizationClaim => ({ aud: 'shopgate-bi-job-auth-v1',
  workspace_id: 'account:member-a', dataset_id: 'official', actor_id: 'member-a',
  session_id: 'session-a', version: 1, job_id: 'job-a', kind: 'confirm_import',
  request_hash: 'a'.repeat(64), phase: 'commit', capabilities: ['job.authorize'],
  iat: Math.floor(NOW.getTime() / 1000), exp: Math.floor(NOW.getTime() / 1000) + 25, ...extra });
const session = (extra = {}, user = {}) => ({ id: 'session-a', userId: 'member-a',
  createdAt: new Date('2026-10-25T07:00:00Z'), expiresAt: new Date('2026-10-25T09:00:00Z'),
  impersonatedBy: null, user: { id: 'member-a', role: 'member', banned: false, banExpires: null,
    mustChangePassword: false, passwordChangedAt: null, ...user }, ...extra });
const headers = (extra = {}) => new Headers({ authorization: `Bearer ${signBiServiceClaims({ ...claims(extra) })}` });
const policy = (readOnly = false) => ({ profile: { key: readOnly ? 'read-only' : 'member-default',
  grants: ['commerce.data.read', 'project.read', ...(readOnly ? [] : ['commerce.operation.manage'])]
    .map((permissionKey) => ({ permissionKey, effect: 'allow' })) }, userOverrides: [] as unknown[] });

describe('current authority for durable BI jobs', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', 'private-job-auth-only-test-credential');
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local');
    vi.stubEnv('SHOPGATE_AUTH_SECRET', 'auth-only-test-secret-not-external');
    mocks.session.mockReset().mockResolvedValue(session());
    mocks.role.mockReset().mockResolvedValue('editor');
    mocks.policy.mockReset().mockResolvedValue(policy());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('looks up an actual persisted session without selecting its bearer token', async () => {
    const result = await requireBiJobAuthorization(headers());
    const body = JSON.parse(Buffer.from(result.split('.')[0], 'base64url').toString());
    expect(body).toMatchObject({ ...claims(), aud: 'shopgate-bi-job-grant-v1', capabilities: ['job.authorized'], exp: claims().iat + 20 });
    expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'session-a' } }));
    expect(mocks.session.mock.calls[0][0].select).not.toHaveProperty('token');
    expect(mocks.policy).toHaveBeenCalledWith({ userId: 'member-a' });
  });

  it.each([
    { exp: claims().iat }, { iat: claims().iat + 1 }, { exp: claims().iat + 31 },
    { version: true }, { version: Number.MAX_SAFE_INTEGER + 1 }, { session_id: '../private' },
    { aud: 'shopgate-bi-v1' }, { actor_id: 'bad/actor' }, { kind: 'run_sql' },
    { request_hash: 'not-a-hash' }, { phase: 'anything' }, { capabilities: ['ledger.manage'] },
    { browser_role: 'admin' },
  ])('rejects malformed/purpose-confused claims before DB %o', async (change) => {
    await expect(requireBiJobAuthorization(headers(change))).rejects.toMatchObject({ status: 403 });
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each([null, '', 'Bearer invalid.signature', 'Bearer é.a', 'Basic x'])('rejects unsigned service request %s', async (value) => {
    const supplied = new Headers(); if (value !== null) supplied.set('authorization', value);
    await expect(requireBiJobAuthorization(supplied)).rejects.toMatchObject({ status: 403 });
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('never treats an auth-disabled local admin as a durable user session', async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'disabled');
    await expect(requireBiJobAuthorization(headers())).rejects.toMatchObject({ status: 403 });
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each([
    null, session({ userId: 'other' }), session({ id: 'other' }),
    session({ expiresAt: NOW }), session({ impersonatedBy: 'admin' }),
    session({}, { id: 'other' }), session({}, { banned: true }),
    session({}, { mustChangePassword: true }),
    session({}, { passwordChangedAt: new Date('2026-10-25T07:30:00Z') }),
  ])('rejects deleted/revoked/expired/changed actual session %#', async (stored) => {
    mocks.session.mockResolvedValue(stored);
    await expect(requireBiJobAuthorization(headers())).rejects.toMatchObject({ status: 403 });
    expect(mocks.policy).not.toHaveBeenCalled();
  });

  it('accepts expired bans but never stale account capability grants', async () => {
    mocks.session.mockResolvedValue(session({}, { banned: true, banExpires: new Date('2026-10-24T00:00:00Z') }));
    await expect(requireBiJobAuthorization(headers())).resolves.toEqual(expect.any(String));
    mocks.policy.mockResolvedValue({ ...policy(), userOverrides: [
      { permissionKey: 'commerce.operation.manage', effect: 'deny' },
    ] });
    await expect(requireBiJobAuthorization(headers())).rejects.toMatchObject({ status: 403 });
  });

  it('allows a read-only account to export but not modify or preview', async () => {
    mocks.policy.mockResolvedValue(policy(true));
    await expect(requireBiJobAuthorization(headers({ kind: 'export_standard' }))).resolves.toEqual(expect.any(String));
    for (const kind of ['preview_import', 'prepare_demo', 'confirm_import']) {
      await expect(requireBiJobAuthorization(headers({ kind }))).rejects.toMatchObject({ status: 403 });
    }
  });

  it('rechecks current shared project membership and role at every call', async () => {
    const shared = () => headers({ workspace_id: 'project-a' });
    await expect(requireBiJobAuthorization(shared())).resolves.toEqual(expect.any(String));
    expect(mocks.role).toHaveBeenCalledWith('member-a', 'project-a');
    mocks.role.mockResolvedValue('viewer');
    await expect(requireBiJobAuthorization(shared())).rejects.toMatchObject({ status: 403 });
    await expect(requireBiJobAuthorization(headers({ workspace_id: 'project-a', kind: 'export_standard' }))).resolves.toEqual(expect.any(String));
    mocks.role.mockResolvedValue(null);
    await expect(requireBiJobAuthorization(shared())).rejects.toMatchObject({ status: 403 });
  });

  it('never authorizes another account workspace even for a platform administrator', async () => {
    mocks.session.mockResolvedValue(session({}, { role: 'admin' }));
    await expect(requireBiJobAuthorization(headers({ workspace_id: 'account:other' }))).rejects.toMatchObject({ status: 403 });
    await expect(requireBiJobAuthorization(headers({ workspace_id: 'project-a' }))).resolves.toEqual(expect.any(String));
    expect(mocks.role).not.toHaveBeenCalled();
  });

  it('revalidates expiry after slow policy IO before minting any grant', async () => {
    mocks.policy.mockImplementation(async () => { vi.setSystemTime(new Date(NOW.getTime() + 30_000)); return policy(); });
    await expect(requireBiJobAuthorization(headers())).rejects.toThrow();
  });

  it('handler masks unexpected DB errors and marks grants non-cacheable', async () => {
    const request = () => new NextRequest('http://localhost/api/internal/bi/job-authorization', { method: 'POST', headers: headers() });
    const good = await POST(request());
    expect(good.status).toBe(200);
    expect(good.headers.get('cache-control')).toContain('no-store');
    expect((await good.json()).data.token).toEqual(expect.any(String));
    mocks.session.mockRejectedValue(new Error('postgres://private-password@private-host private-cell'));
    const bad = await POST(request());
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain('private-password');
  });

  it('requires a distinct short authorization audience at the proxy gate', () => {
    expect(verifyJobAuthorizationRequest(headers().get('authorization'))).toMatchObject(claims());
    const grant = signBiServiceClaims({ ...claims(), aud: 'shopgate-bi-job-grant-v1', capabilities: ['job.authorized'] });
    expect(() => verifyJobAuthorizationRequest(`Bearer ${grant}`)).toThrow();
  });
});
