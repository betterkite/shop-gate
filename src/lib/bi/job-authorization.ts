import { PrismaPermissionPolicyRepository } from '@/lib/auth/action';
import { AuthorizationError, isActiveBan, isPlatformAdmin, projectRoleForUser } from '@/lib/auth/authorization';
import { evaluatePermission, type PermissionAction } from '@/lib/auth/permissions';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';
import { signBiServiceClaims, verifyJobAuthorizationRequest, type JobAuthorizationClaim } from './job-signatures';

/**
 * Reads the real persisted session/user and current policy/membership. This is not
 * requireAction with an invented session, and never accepts self-reported identity.
 * Only the private, distinct-purpose service signature enters this function.
 */
export async function requireBiJobAuthorization(headers: Headers) {
  const deny = () => { throw new AuthorizationError('BI_JOB_AUTH_REVOKED', 403, '任务授权已失效，请重新登录并检查权限。'); };
  let claim: JobAuthorizationClaim;
  try { claim = verifyJobAuthorizationRequest(headers.get('authorization')); } catch { return deny(); }
  if (!getProjectAuthConfig().enabled) return deny();
  const session = await prisma.authSession.findUnique({
    where: { id: claim.session_id },
    select: { id: true, userId: true, createdAt: true, expiresAt: true, impersonatedBy: true,
      user: { select: { id: true, role: true, banned: true, banExpires: true,
        mustChangePassword: true, passwordChangedAt: true } } },
  });
  const now = new Date();
  if (!session || session.id !== claim.session_id || session.userId !== claim.actor_id
      || session.user.id !== claim.actor_id || !Number.isFinite(session.expiresAt.getTime())
      || session.expiresAt <= now || session.impersonatedBy || isActiveBan(session.user)
      || session.user.mustChangePassword || (session.user.passwordChangedAt
        && session.user.passwordChangedAt > session.createdAt)) return deny();
  const admin = isPlatformAdmin(session.user);
  const actor = { id: session.user.id, platformRole: admin ? 'admin' as const : 'member' as const };
  const personal = claim.workspace_id.startsWith('account:');
  if (personal && claim.workspace_id !== `account:${actor.id}`) return deny();
  const role = personal ? null : admin ? 'owner'
    : await projectRoleForUser(actor.id, claim.workspace_id);
  const write = claim.kind !== 'export_standard';
  if (!personal && (!role || (write && role !== 'owner' && role !== 'editor'))) return deny();
  const policy = admin ? undefined : await new PrismaPermissionPolicyRepository().resolvePolicy({ userId: actor.id });
  const actions: PermissionAction[] = ['commerce.data.read'];
  if (!personal) actions.push('project.read');
  if (write) actions.push('commerce.operation.manage');
  for (const action of actions) {
    const decision = evaluatePermission({ action, actor, policy,
      ...(action === 'project.read' ? { project: { id: claim.workspace_id, role } } : {}), now });
    if (!decision.allowed) return deny();
  }
  // Request may expire during DB/policy I/O. Re-check it before minting a short grant.
  try { verifyJobAuthorizationRequest(headers.get('authorization')); } catch { return deny(); }
  const issuedAt = Math.floor(Date.now() / 1000);
  return signBiServiceClaims({ ...claim, aud: 'shopgate-bi-job-grant-v1',
    capabilities: ['job.authorized'], iat: issuedAt, exp: issuedAt + 20 });
}
