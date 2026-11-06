import { Prisma } from '@prisma/client';
import { assertStructuralQuotaCapacity } from '@/lib/quota/service';

/** Both dispatch paths call this under the same real actor row lock. */
export async function assertAgentExecutionCapacity(tx: Prisma.TransactionClient, actorId: string,
  exclude: { generationJobId?: string; biRunId?: string }, now: Date) {
  const actor = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM auth_users WHERE id=${actorId} FOR UPDATE`);
  if (!actor.length) throw new Error('Agent actor no longer exists.');
  const jobs = await tx.agentGenerationJob.count({ where: { status: 'running',
    ...(exclude.generationJobId ? { id: { not: exclude.generationJobId } } : {}), request: { actorUserId: actorId } } });
  const analyses = await tx.agentRun.count({ where: { biRequestId: { not: null }, actorUserId: actorId,
    status: { in: ['running', 'waiting', 'reconciling'] }, ...(exclude.biRunId ? { id: { not: exclude.biRunId } } : {}) } });
  await assertStructuralQuotaCapacity(tx, { actorUserId: actorId, metric: 'agent.concurrent', current: jobs + analyses, now });
}
