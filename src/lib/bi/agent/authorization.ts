import type { PrismaClient, Prisma } from '@prisma/client';
import { requireAction, PrismaPermissionPolicyRepository } from '@/lib/auth/action';
import { AuthorizationError, isActiveBan, isPlatformAdmin } from '@/lib/auth/authorization';
import { evaluatePermission, type PermissionAction } from '@/lib/auth/permissions';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';
import { biAgentIdentifier } from './contracts';

type Client = Pick<PrismaClient, 'authSession' | 'authUser' | 'permissionProfile' | 'project'>;
export type BiAgentAuthority = { actorId: string; sessionId: string; workspaceId: string };
export type BiAgentAccess = 'read' | 'run' | 'manage';
const deny = (): never => { throw new AuthorizationError('BI_AGENT_AUTH_REVOKED', 403,
  '经营助手的登录或访问权限已失效，请重新登录并检查当前工作空间。'); };

/** The session ID is an internal reference, NOT a bearer accepted from HTTP input. */
export async function recheckBiAgentSession(sessionId: string, workspaceId: string,
  access: BiAgentAccess, client: Client | Prisma.TransactionClient = prisma): Promise<BiAgentAuthority> {
  if (!getProjectAuthConfig().enabled || !biAgentIdentifier.safeParse(workspaceId).success
      || !biAgentIdentifier.safeParse(sessionId).success) return deny();
  const session = await client.authSession.findUnique({ where: { id: sessionId }, select: {
    id: true, userId: true, createdAt: true, expiresAt: true, impersonatedBy: true,
    user: { select: { id: true, role: true, banned: true, banExpires: true,
      mustChangePassword: true, passwordChangedAt: true } },
  } });
  const now = new Date();
  if (!session || session.userId !== session.user.id || session.impersonatedBy
      || !Number.isFinite(session.expiresAt.getTime()) || session.expiresAt <= now
      || isActiveBan(session.user) || session.user.mustChangePassword
      || (session.user.passwordChangedAt && session.user.passwordChangedAt > session.createdAt)) return deny();
  const personal = workspaceId.startsWith('account:');
  const admin = isPlatformAdmin(session.user);
  if (personal && workspaceId !== `account:${session.user.id}`) return deny();
  let role: 'owner' | 'editor' | 'viewer' | null = null;
  if (!personal) {
    const project = await client.project.findUnique({ where: { id: workspaceId }, select: {
      ownerId: true, memberships: { where: { userId: session.user.id }, select: { role: true }, take: 1 },
    } });
    if (!project) return deny();
    const actual = project.ownerId === session.user.id || admin ? 'owner' : project.memberships[0]?.role;
    if (actual !== 'owner' && actual !== 'editor' && actual !== 'viewer') return deny();
    role = actual;
    if (access === 'manage' && role === 'viewer') return deny();
  }
  const policy = admin ? undefined : await new PrismaPermissionPolicyRepository(client)
    .resolvePolicy({ userId: session.user.id, ...(!personal ? { projectId: workspaceId } : {}) });
  const actions: PermissionAction[] = ['commerce.data.read'];
  if (!personal) actions.push('project.read');
  // The legacy agent.run requires a filesystem Project. BI uses its account-level
  // operation capability and separately intersects current shared membership.
  if (access === 'run') actions.push('commerce.operation.run');
  if (access === 'manage') actions.push('commerce.operation.manage');
  for (const action of actions) {
    if (!evaluatePermission({ action, actor: { id: session.user.id, platformRole: admin ? 'admin' : 'member' },
      policy, now, ...(action === 'project.read' ? { project: { id: workspaceId, role } } : {}) }).allowed) return deny();
  }
  // Avoid granting after a slow policy read has already outlived this session.
  if (session.expiresAt.getTime() <= Date.now()) return deny();
  return { actorId: session.user.id, sessionId: session.id, workspaceId };
}

/** HTTP adapters call this first; never deserialize a session or actor from JSON. */
export async function authenticateBiAgent(headers: Headers, workspaceId?: string,
  access: BiAgentAccess = 'read'): Promise<BiAgentAuthority> {
  const context = await requireAction({ headers, action: 'commerce.data.read' });
  const sessionId = context.session?.session?.id;
  if (context.localSystemAdmin || !sessionId) return deny();
  const authority = await recheckBiAgentSession(sessionId, workspaceId ?? `account:${context.actorUserId}`, access);
  if (authority.actorId !== context.actorUserId) return deny();
  return authority;
}
