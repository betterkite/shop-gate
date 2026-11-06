import { Prisma } from '@prisma/client';
import { assertStructuralQuotaCapacity } from '@/lib/quota';

/** Both inboxes serialize admission on the actual account, including legacy
 * requests accepted before their generation job has been created. */
export async function assertAgentPendingCapacity(tx: Prisma.TransactionClient, actorUserId: string) {
  await lockAgentRequestActor(tx, actorUserId);
  const legacy = await tx.userRequest.count({ where: {
    actorUserId, status: { in: ['pending', 'processing', 'active', 'running'] },
    OR: [{ generationJob: null }, { generationJob: { is: { status: { in: ['pending', 'retry_wait'] } } } }],
  } });
  const analyses = await tx.agentRun.count({ where: {
    actorUserId, biRequestId: { not: null }, status: 'pending',
  } });
  await assertStructuralQuotaCapacity(tx, {
    actorUserId, metric: 'agent.pending', current: legacy + analyses,
  });
}

/** Acquire before inserting any actor foreign key: two KEY SHARE holders must
 * not both try to upgrade to FOR UPDATE while creating independent scopes. */
export async function lockAgentRequestActor(tx: Prisma.TransactionClient, actorUserId: string) {
  const actors = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM auth_users WHERE id=${actorUserId} FOR UPDATE`);
  if (!actors[0]) throw new Error('The request actor no longer exists.');
}
