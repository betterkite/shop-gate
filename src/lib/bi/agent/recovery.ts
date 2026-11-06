import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { reconcileExpiredPiAgentRuns } from '@/lib/services/pi-agent-recovery';
import { settleAgentRunUsage } from '@/lib/services/pi-agent-usage-settlement';
import { publishBiAgentAnswer } from './completion';

/** Bounded restart/periodic maintenance. Never repeats a previous provider call. */
export async function recoverBiAgentExecutions(client: PrismaClient = prisma) {
  const scopes = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT execution_scope_id AS id FROM agent_runs
    WHERE bi_request_id IS NOT NULL AND status IN ('running', 'waiting', 'reconciling')
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    ORDER BY execution_scope_id LIMIT 100`);
  const repository = new PrismaAgentRuntimeRepository(client);
  for (const scope of scopes) {
    await reconcileExpiredPiAgentRuns({ repository, executionScopeId: scope.id });
  }
  const candidates = await client.agentRun.findMany({ where: { biRequestId: { not: null }, status: 'candidate_complete' },
    orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true } });
  for (const run of candidates) await publishBiAgentAnswer(run.id, client);
  const unsettled = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r.id FROM agent_runs r WHERE r.bi_request_id IS NOT NULL AND r.finished_at IS NOT NULL
      AND r.status NOT IN ('pending', 'running', 'waiting', 'reconciling') AND (
        (r.total_tokens > 0 AND NOT EXISTS (SELECT 1 FROM usage_events u
          WHERE u.idempotency_key = 'agent-run:' || r.id || ':total-tokens'))
        OR EXISTS (SELECT 1 FROM quota_reservations q
          WHERE q.idempotency_key = 'bi-agent:' || r.id || ':tokens' AND q.status='active'))
    ORDER BY r.finished_at, r.id LIMIT 100`);
  for (const run of unsettled) await settleAgentRunUsage(client, run.id);
  return { scopes: scopes.length, candidates: candidates.length, settled: unsettled.length };
}
