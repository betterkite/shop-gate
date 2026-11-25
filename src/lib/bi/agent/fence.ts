import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { recheckBiAgentSession } from './authorization';
import { authorizeBiAgentRun } from './requests';
import { BiAgentProblem } from './contracts';

export type BiAgentResultFence = { runId: string; leaseOwner: string; fencingToken: number; workspaceFencingToken: number };
const problem = () => new BiAgentProblem('BI_AGENT_CONFLICT', 409, '分析执行已变化或结果不完整，请重新提问。');

/** Same scope-then-run lock order as durable runtime. Heartbeat versions may
 * advance, but an expired/replaced/cancelled writer never publishes facts. */
export async function writeFenced<T>(fence: BiAgentResultFence, client: PrismaClient,
  write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const authorized = await authorizeBiAgentRun(fence.runId, client);
  return client.$transaction(async (tx) => {
    // Acquire locks first; only then sample the database clock. Evaluating
    // expiry before a blocked FOR UPDATE could admit a lease that expired while waiting.
    await tx.$queryRaw(Prisma.sql`SELECT execution_scope_id FROM agent_workspace_leases
      WHERE execution_scope_id=${authorized.run.executionScopeId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id=${fence.runId} FOR UPDATE`);
    const valid = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
      SELECT (r.status='running' AND r.lease_owner=${fence.leaseOwner} AND r.fencing_token=${fence.fencingToken}
        AND r.workspace_fencing_token=${fence.workspaceFencingToken} AND r.lease_expires_at>clock_timestamp()
        AND r.cancel_requested_at IS NULL AND l.status='held' AND l.active_run_id=r.id
        AND l.lease_owner=${fence.leaseOwner} AND l.fencing_token=${fence.workspaceFencingToken}
        AND l.lease_expires_at>clock_timestamp()) AS valid
      FROM agent_runs r JOIN agent_workspace_leases l ON l.execution_scope_id=r.execution_scope_id
      WHERE r.id=${fence.runId}`);
    if (!valid[0]?.valid) throw problem();
    const current = await recheckBiAgentSession(authorized.authority.sessionId, authorized.authority.workspaceId, 'run', tx);
    if (current.actorId !== authorized.authority.actorId) throw problem();
    return write(tx);
  }, { maxWait: 5000, timeout: 15_000 });
}

export async function assertBiAgentResultFence(fence: BiAgentResultFence, client: PrismaClient = prisma) {
  await writeFenced(fence, client, async () => undefined);
}
