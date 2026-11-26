import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { createQuotaService } from '@/lib/quota/service';
import { listUnmeteredAgentRuns } from './pi-agent-usage-reconciliation';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_usage_${randomUUID().replaceAll('-', '')}`;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
describe.skipIf(!databaseUrl)('Agent usage reconciliation (real PostgreSQL)', () => {
  let a: PrismaClient, b: PrismaClient;
  const actorId = `${prefix}:actor`, projectId = `${prefix}:project`;
  beforeAll(async () => {
    a = new PrismaClient({ datasourceUrl: databaseUrl! }); b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
    await a.authUser.create({ data: { id: actorId, name: 'Owned usage test', email: `${actorId}@example.invalid` } });
    await a.project.create({ data: { id: projectId, name: 'Legacy usage test', ownerId: actorId } });
  });
  afterAll(async () => {
    try {
      await a.agentExecutionScope.deleteMany({ where: { ownerUserId: actorId } });
      await a.usageEvent.deleteMany({ where: { actorUserId: actorId } });
      await a.project.delete({ where: { id: projectId } });
      await a.authUser.delete({ where: { id: actorId } });
    } finally { await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });
  it('drains both Project and NULL-Project BI usage once and preserves exact totals on later scans', async () => {
    const repository = new PrismaAgentRuntimeRepository(a);
    const scope = await a.agentExecutionScope.create({ data: { kind: 'bi_dataset',
      workspaceId: `account:${actorId}`, datasetId: 'usage-demo', ownerUserId: actorId } });
    const conversation = await a.biAgentConversation.create({ data: { executionScopeId: scope.id, actorUserId: actorId, title: 'Usage test' } });
    const bi = await a.biAgentRequest.create({ data: { conversationId: conversation.id, executionScopeId: scope.id, actorUserId: actorId,
      idempotencyKey: 'usage', instruction: '使用实际账本分析', inputHash: 'a'.repeat(64), pageScope: {}, datasetVersion: 1, model: 'deepseek-v4-flash' } });
    const legacy = await a.userRequest.create({ data: { projectId, actorUserId: actorId, instruction: 'Legacy request' } });
    const ids: string[] = [];
    for (const [index, binding] of [{ projectId, requestId: legacy.id }, { biRequestId: bi.id }].entries()) {
      const run = await repository.createRun({ ...binding, id: `${prefix}:run${index}`,
        workspaceKey: index === 0 ? hash(projectId) : hash(`bi-runtime:${scope.id}`),
        provider: 'deepseek', model: 'deepseek-v4-flash', frameworkVersion: 'pi-agent:usage-test', buildRevision: 'test:usage',
        profileHash: hash('profile'), promptHash: hash('prompt'), toolHash: hash('tools'), skillHash: hash('skills'), workspaceHash: hash('scope'),
        status: 'running', leaseOwner: `${prefix}:worker${index}`, leaseExpiresAt: new Date(Date.now() + 60_000) });
      ids.push(run.id);
      await repository.completeRun({ runId: run.id, expectedVersion: run.version, leaseOwner: run.leaseOwner!,
        fencingToken: run.fencingToken, workspaceFencingToken: run.workspaceFencingToken, status: 'completed', turnCount: 1,
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11, cachedInputTokens: 0, cacheMissInputTokens: 7, reasoningTokens: 0 } });
    }
    const pending = (await listUnmeteredAgentRuns(b, 10_000)).filter((r) => ids.includes(r.id));
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.projectId)).toContain(null);
    expect(pending.map((r) => r.projectId)).toContain(projectId);
    const quota = createQuotaService(a);
    for (const run of pending) {
      await quota.recordUsage({ actorUserId: run.actorUserId, projectId: run.projectId,
        metric: 'llm.total_tokens.monthly', quantity: run.totalTokens, idempotencyKey: `agent-run:${run.id}:total-tokens`,
        sourceType: 'agent_run', sourceId: run.id, occurredAt: run.finishedAt });
    }
    // The old `=` comparison returns the BI row here even after successful settlement.
    for (let scan = 0; scan < 2; scan++) {
      expect((await listUnmeteredAgentRuns(b, 10_000)).filter((r) => ids.includes(r.id))).toEqual([]);
    }
    const events = await a.usageEvent.findMany({ where: { actorUserId: actorId } });
    expect(events).toHaveLength(2);
    expect(events.reduce((sum, event) => sum + event.quantity, 0n)).toBe(22n);
    expect((await a.usageBucket.findMany({ where: { actorUserId: actorId } })).reduce((sum, bucket) => sum + bucket.used, 0n)).toBe(22n);
  });
});
