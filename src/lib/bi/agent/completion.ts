import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { AuthorizationError } from '@/lib/auth/authorization';
import { recheckBiAgentSession } from './authorization';
import { definitionsForAnswer } from './metric-sources';
import { BiAgentProblem } from './contracts';
import { biAgentAnswerSchema } from './result-contracts';

/** Publish a completed read-only analysis, including after worker restart.
 * Legacy generated projects still require their separate artifact verifier. */
export async function publishBiAgentAnswer(runId: string, client: PrismaClient = prisma) {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id=${runId} FOR UPDATE`);
    const run = await tx.agentRun.findUnique({ where: { id: runId }, include: {
      biRequest: { include: { conversation: { include: { scope: true } } } },
    } });
    if (!run?.biRequest || run.projectId || run.biRequest.conversation.scope.kind !== 'bi_dataset') {
      throw new Error('Only BI analysis candidates may publish a private answer.');
    }
    if (run.status !== 'candidate_complete') return { status: run.status };
    let failure: string | null = run.cancelRequestedAt ? 'BI_AGENT_CANCELLED' : null;
    const request = run.biRequest, scope = request.conversation.scope;
    if (!failure) {
      try {
        const actor = await recheckBiAgentSession(request.sessionId ?? '', scope.workspaceId, 'run', tx);
        if (actor.actorId !== run.actorUserId || actor.actorId !== request.actorUserId) failure = 'BI_AGENT_AUTH_REVOKED';
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        failure = 'BI_AGENT_AUTH_REVOKED';
      }
    }
    if (!failure) {
      const answer = await tx.biAgentAnswer.findUnique({ where: { runId } });
      const parsed = biAgentAnswerSchema.safeParse(answer?.content);
      const receipt = await tx.agentToolExecution.findFirst({ where: { runId, toolName: 'submit_answer',
        status: 'succeeded', effect: 'read', fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken } });
      if (!run.finishedAt || !parsed.success || !receipt) failure = 'BI_AGENT_ANSWER_INCOMPLETE';
      else {
        try { await definitionsForAnswer(tx, runId, parsed.data); } catch (error) {
          if (!(error instanceof BiAgentProblem)) throw error;
          failure = 'BI_AGENT_ANSWER_INCOMPLETE';
        }
        const results = await tx.biAgentResult.findMany({ where: { runId, complete: true,
          id: { in: parsed.data.evidence_ids } }, select: { id: true, collected: true, total: true } });
        if (results.length !== parsed.data.evidence_ids.length || results.some((r) => r.collected !== r.total)) {
          failure = 'BI_AGENT_ANSWER_INCOMPLETE';
        }
      }
    }
    const status = failure === 'BI_AGENT_CANCELLED' ? 'cancelled' : failure ? 'failed' : 'completed';
    await tx.agentRun.update({ where: { id: runId }, data: { status, errorCode: failure,
      errorMessage: failure ? '分析未通过最终校验，请检查登录与数据后重新提问。' : null,
      version: { increment: 1 } } });
    return { status };
  }, { maxWait: 5000, timeout: 15_000 });
}
