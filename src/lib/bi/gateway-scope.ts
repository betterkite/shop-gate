// Node-only service boundary. Tokens stay server-side; never return them in a page response.
import { createHmac } from 'node:crypto';

import { requireAction, type RequiredActionContext } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,120}$/;

export interface LedgerGatewayInput {
  headers: Headers;
  datasetId: string;
  version: number;
  workspaceId?: string;
  write?: boolean;
}

function authenticated(context: RequiredActionContext) {
  if (!context.session || context.localSystemAdmin) {
    throw new AuthorizationError('AUTHENTICATION_REQUIRED', 401, '经营账本需要登录身份。');
  }
  return context;
}

function sameActor(actual: RequiredActionContext, expected: RequiredActionContext) {
  authenticated(actual);
  if (actual.actorUserId !== expected.actorUserId) {
    throw new AuthorizationError('AUTH_CONTEXT_CHANGED', 403, '授权身份已变化，请重新登录。');
  }
}

/**
 * Personal workspace = account:<authenticated user>. Shared workspace = an
 * existing project checked via the current membership/capability boundary.
 * actorUserId and capabilities cannot be supplied by a browser or a model.
 * Dataset/version are still checked by the ledger transaction, not assumed true.
 */
export async function issueLedgerScope(input: LedgerGatewayInput) {
  if (typeof window !== 'undefined') throw new Error('Ledger service authorization is server-only.');
  if (!IDENTIFIER.test(input.datasetId) || !Number.isSafeInteger(input.version) || input.version < 1
      || (input.write !== undefined && typeof input.write !== 'boolean')) {
    throw new TypeError('数据集、版本或操作范围无效。');
  }
  const actor = authenticated(await requireAction({
    headers: input.headers, action: 'commerce.data.read',
  }));
  if (!IDENTIFIER.test(actor.actorUserId)) throw new TypeError('登录身份标识无效。');
  const personalWorkspace = `account:${actor.actorUserId}`;
  const workspaceId = input.workspaceId ?? personalWorkspace;
  if (!IDENTIFIER.test(workspaceId)) throw new TypeError('工作空间标识无效。');
  if (workspaceId.startsWith('account:')) {
    if (workspaceId !== personalWorkspace) {
      throw new AuthorizationError('WORKSPACE_NOT_FOUND', 404, '工作空间不存在或当前用户无权访问。');
    }
  } else {
    const project = authenticated(await requireAction({
      headers: input.headers, action: 'project.read', projectId: workspaceId,
    }));
    sameActor(project, actor);
    if (input.write && project.projectRole !== 'owner' && project.projectRole !== 'editor') {
      throw new AuthorizationError('WORKSPACE_READ_ONLY', 403, '此工作空间只允许查看。');
    }
  }
  if (input.write) {
    sameActor(await requireAction({
      headers: input.headers, action: 'commerce.operation.manage',
    }), actor);
  }
  const secret = process.env.SHOPGATE_BI_SERVICE_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) {
    throw new Error('经营数据服务签名尚未配置；请配置双方相同的服务密钥。');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    aud: 'shopgate-bi-v1',
    workspace_id: workspaceId,
    dataset_id: input.datasetId,
    actor_id: actor.actorUserId,
    version: input.version,
    capabilities: input.write ? ['ledger.read', 'ledger.manage'] : ['ledger.read'],
    iat: issuedAt,
    exp: issuedAt + 120,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return {
    workspaceId, datasetId: input.datasetId, actorId: actor.actorUserId,
    version: input.version, expiresAt: claims.exp, token: `${encoded}.${signature}`,
  };
}
