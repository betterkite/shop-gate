import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAction: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
import { issueLedgerScope } from './gateway-scope';

const TEST_SECRET = 'ledger-only-test-key-not-a-real-credential';
const context = (role: 'owner' | 'editor' | 'viewer' = 'owner', actor = 'member-a') => ({
  actorUserId: actor, session: { user: { id: actor } }, projectRole: role, localSystemAdmin: false,
});

describe('authenticated ledger gateway scope', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', TEST_SECRET);
    mocks.requireAction.mockReset().mockResolvedValue(context());
  });
  afterEach(() => vi.unstubAllEnvs());

  it('signs personal scope from authenticated actor, not forged browser headers', async () => {
    const result = await issueLedgerScope({
      headers: new Headers({ 'x-user-id': 'another-user', 'x-workspace-id': 'foreign' }),
      datasetId: 'demo', version: 1,
    });
    const [encoded, signature] = result.token.split('.');
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    expect(claims).toMatchObject({
      aud: 'shopgate-bi-v1', workspace_id: 'account:member-a', actor_id: 'member-a',
      dataset_id: 'demo', version: 1, capabilities: ['ledger.read'],
    });
    expect(claims.exp - claims.iat).toBe(120);
    expect(signature).toBe(createHmac('sha256', TEST_SECRET).update(encoded).digest('base64url'));
  });

  it('does not authorize another personal workspace', async () => {
    await expect(issueLedgerScope({
      headers: new Headers(), datasetId: 'demo', version: 1, workspaceId: 'account:other',
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND', status: 404 });
  });

  it('requires actual shared-project membership', async () => {
    mocks.requireAction.mockResolvedValueOnce(context()).mockRejectedValueOnce(
      new Error('project membership denied'),
    );
    await expect(issueLedgerScope({
      headers: new Headers(), datasetId: 'demo', version: 1, workspaceId: 'project-a',
    })).rejects.toThrow('membership denied');
    expect(mocks.requireAction).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'project.read', projectId: 'project-a',
    }));
  });

  it('lets viewers read but never signs mutation capabilities', async () => {
    mocks.requireAction.mockResolvedValue(context('viewer'));
    const input = {
      headers: new Headers(), datasetId: 'demo', version: 1, workspaceId: 'project-a',
    };
    const result = await issueLedgerScope(input);
    expect(JSON.parse(Buffer.from(result.token.split('.')[0], 'base64url').toString())
      .capabilities).toEqual(['ledger.read']);
    await expect(issueLedgerScope({ ...input, write: true }))
      .rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY', status: 403 });
  });

  it('intersects editor membership with account management capability', async () => {
    mocks.requireAction.mockResolvedValue(context('editor'));
    const input = {
      headers: new Headers(), datasetId: 'demo', version: 1, workspaceId: 'project-a', write: true,
    };
    const result = await issueLedgerScope(input);
    expect(mocks.requireAction).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'commerce.operation.manage',
    }));
    expect(JSON.parse(Buffer.from(result.token.split('.')[0], 'base64url').toString())
      .capabilities).toEqual(['ledger.read', 'ledger.manage']);
  });

  it('denies mutation when the account capability is denied', async () => {
    mocks.requireAction.mockResolvedValueOnce(context()).mockRejectedValueOnce(
      new Error('management capability denied'),
    );
    await expect(issueLedgerScope({
      headers: new Headers(), datasetId: 'demo', version: 1, write: true,
    })).rejects.toThrow('capability denied');
  });

  it('fails closed when session identities change during authorization', async () => {
    mocks.requireAction.mockResolvedValueOnce(context()).mockResolvedValueOnce(
      context('editor', 'another-user'),
    );
    await expect(issueLedgerScope({
      headers: new Headers(), datasetId: 'demo', version: 1, workspaceId: 'project-a',
    })).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED', status: 403 });
  });

  it('does not inherit the auth-disabled local system administrator bypass', async () => {
    mocks.requireAction.mockResolvedValue({ session: null, actorUserId: 'local-system-admin',
      localSystemAdmin: true });
    await expect(issueLedgerScope({ headers: new Headers(), datasetId: 'demo', version: 1 }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED', status: 401 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects an invalid or lossy version %s', async (version) => {
      await expect(issueLedgerScope({ headers: new Headers(), datasetId: 'demo', version }))
        .rejects.toThrow('版本');
    },
  );

  it('does not sign when the service secret is missing', async () => {
    vi.stubEnv('SHOPGATE_BI_SERVICE_SECRET', '');
    await expect(issueLedgerScope({ headers: new Headers(), datasetId: 'demo', version: 1 }))
      .rejects.toThrow('签名尚未配置');
  });
});
