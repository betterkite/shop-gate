import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { submitBiAgentQuestion } from '@/lib/bi/agent/requests';
import { biAgentPageScopeSchema } from '@/lib/bi/agent/contracts';
import { createQuotaService } from '@/lib/quota/service';
import { PiAgentDurableRunSession } from './pi-agent-run-store';
import { biAgentTokenReservationKey, settleAgentRunUsage } from './pi-agent-usage-settlement';
import { claimPiAgentWorkerSlot, heartbeatPiAgentWorkerSlot, releasePiAgentWorkerSlot } from './pi-agent-worker-capacity';
import { registerPiAgentWorkerInstance, stopPiAgentWorkerInstance, hasLivePiAgentWorker } from './pi-agent-worker-registry';
import { claimPiAgentGenerationJob, finishPiAgentGenerationJob } from './pi-agent-generation-dispatch-store';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_accounting_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!databaseUrl)('Shared BI execution accounting (real PostgreSQL)', () => {
  let a: PrismaClient, b: PrismaClient; let seq = 0;
  const users: string[] = [], projects: string[] = [];
  const unique = () => `${prefix}:${++seq}`;
  async function identity() {
    const id = unique(), sessionId = unique(); users.push(id);
    await a.authUser.create({ data: { id, name: 'Owned accounting test', email: `${id}@example.invalid` } });
    await a.authSession.create({ data: { id: sessionId, userId: id, token: unique(), expiresAt: new Date(Date.now() + 3_600_000) } });
    await a.userQuotaOverride.createMany({ data: [
      { userId: id, metric: 'agent.concurrent', limit: 1n, enforcement: 'hard', windowType: 'lifetime' },
      { userId: id, metric: 'llm.total_tokens.monthly', limit: 100_000n, enforcement: 'hard', windowType: 'month' },
    ] });
    return { actorId: id, sessionId, workspaceId: `account:${id}` };
  }
  async function pending(actor: Awaited<ReturnType<typeof identity>>) {
    const accepted = await submitBiAgentQuestion(actor, { dataset_id: unique(), dataset_version: 2,
      conversation_id: randomUUID(), expected_conversation_version: 0, idempotency_key: unique(),
      instruction: '解释当前经营结果', model: 'deepseek-v4-flash', page_scope: { module: 'overview' } },
    { client: a, resolvePage: async () => biAgentPageScopeSchema.parse({ module: 'overview' }) });
    return accepted.request.runs[0].id;
  }
  async function claim(id: string, client = a) {
    const session = await PiAgentDurableRunSession.claimPending({ repository: new PrismaAgentRuntimeRepository(client),
      runId: id, expectedVersion: 0, heartbeatEnabled: false });
    const run = session.run; await session.close(); return run;
  }
  async function finish(run: Awaited<ReturnType<typeof claim>>, total = 11) {
    await new PrismaAgentRuntimeRepository(a).completeRun({ runId: run.id, expectedVersion: run.version,
      leaseOwner: run.leaseOwner!, fencingToken: run.fencingToken, workspaceFencingToken: run.workspaceFencingToken,
      status: 'completed', turnCount: 1, usage: { inputTokens: total, outputTokens: 0, totalTokens: total,
        cachedInputTokens: 0, cacheMissInputTokens: total, reasoningTokens: 0 } });
  }
  async function legacy(actor: Awaited<ReturnType<typeof identity>>) {
    const projectId = unique(); projects.push(projectId);
    await a.project.create({ data: { id: projectId, name: 'Owned legacy dispatch', ownerId: actor.actorId } });
    const request = await a.userRequest.create({ data: { projectId, actorUserId: actor.actorId, instruction: 'Legacy task' } });
    await a.agentGenerationJob.create({ data: { projectId, requestId: request.id,
      executionEnvelope: {}, instructionHash: 'a'.repeat(64), instructionPreview: 'Legacy task' } });
    return { projectId, requestId: request.id, leaseOwner: unique(), leaseTtlMs: 60_000 };
  }
  beforeAll(async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local'); vi.stubEnv('SHOPGATE_AUTH_SECRET', 'owned-accounting-auth-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'unused-accounting-test-credential'); vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1');
    a = new PrismaClient({ datasourceUrl: databaseUrl! }); b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
  });
  afterAll(async () => {
    try {
      await a.agentWorkerSlot.deleteMany({ where: { poolKey: { startsWith: prefix } } });
      await a.agentWorkerInstance.deleteMany({ where: { poolKey: { startsWith: prefix } } });
      await a.agentExecutionScope.deleteMany({ where: { ownerUserId: { in: users } } });
      await a.agentGenerationJob.deleteMany({ where: { projectId: { in: projects } } });
      await a.project.deleteMany({ where: { id: { in: projects } } });
      await a.usageEvent.deleteMany({ where: { actorUserId: { in: users } } });
      await a.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { vi.unstubAllEnvs(); await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });

  it('shares real global capacity between BI and legacy jobs and fences replaced owners', async () => {
    const actor = await identity(), run = await claim(await pending(actor)), poolKey = unique();
    const input = { poolKey, capacity: 1, leaseOwner: unique(), leaseTtlMs: 60_000 };
    const biSlot = await claimPiAgentWorkerSlot({ ...input, activeRunId: run.id });
    expect(biSlot).not.toBeNull();
    const legacyInput = { ...input, leaseOwner: unique(), activeJobId: randomUUID() };
    expect(await claimPiAgentWorkerSlot(legacyInput)).toBeNull();
    await a.agentWorkerSlot.updateMany({ where: { poolKey }, data: { leaseExpiresAt: new Date(0) } });
    // Expired slot heartbeat alone does not prove its independently leased run is dead.
    expect(await claimPiAgentWorkerSlot(legacyInput)).toBeNull();
    await finish(run, 0);
    const replacement = await claimPiAgentWorkerSlot(legacyInput);
    expect(replacement!.fencingToken).toBeGreaterThan(biSlot!.fencingToken);
    await expect(heartbeatPiAgentWorkerSlot({ fence: biSlot!, leaseTtlMs: 60_000 }))
      .rejects.toMatchObject({ code: 'WORKER_SLOT_LEASE_LOST' });
    await expect(releasePiAgentWorkerSlot(biSlot!)).rejects.toMatchObject({ code: 'WORKER_SLOT_LEASE_LOST' });
    await releasePiAgentWorkerSlot(replacement!);
  });

  it('keeps live legacy dispatch capacity and enforces one slot per BI run', async () => {
    const actor = await identity(), job = await legacy(actor), poolKey = unique();
    const dispatch = await claimPiAgentGenerationJob(job);
    expect(dispatch).not.toBeNull();
    const row = await a.agentGenerationJob.findUniqueOrThrow({ where: { requestId_projectId: {
      projectId: job.projectId, requestId: job.requestId } } });
    const input = { poolKey, capacity: 1, leaseOwner: unique(), leaseTtlMs: 60_000 };
    const legacySlot = await claimPiAgentWorkerSlot({ ...input, activeJobId: row.id });
    expect(legacySlot).not.toBeNull();
    await a.agentWorkerSlot.updateMany({ where: { poolKey }, data: { leaseExpiresAt: new Date(0) } });
    const biRunId = await pending(await identity());
    expect(await claimPiAgentWorkerSlot({ ...input, activeRunId: biRunId })).toBeNull();
    await finishPiAgentGenerationJob({ projectId: job.projectId, requestId: job.requestId,
      status: 'completed', fence: dispatch! });
    const replacement = await claimPiAgentWorkerSlot({ ...input, activeRunId: biRunId });
    expect(replacement).not.toBeNull();
    expect(await claimPiAgentWorkerSlot({ ...input, capacity: 2, activeRunId: biRunId })).toBeNull();
    await expect(a.agentWorkerSlot.updateMany({ where: { poolKey, slotNumber: replacement!.slotNumber },
      data: { activeJobId: randomUUID() } })).rejects.toThrow();
    await releasePiAgentWorkerSlot(replacement!);
  });

  it('advertises BI availability only for a live BI consumer in the same configured pool', async () => {
    const poolKey = unique(), input = { poolKey, processConcurrency: 1, globalConcurrency: 2, leaseTtlMs: 60_000 };
    const legacyWorker = await registerPiAgentWorkerInstance(input);
    expect(await hasLivePiAgentWorker('project_generation', poolKey)).toBe(true);
    expect(await hasLivePiAgentWorker('bi_analysis', poolKey)).toBe(false);
    await expect(registerPiAgentWorkerInstance({ ...input, workerKind: 'bi_analysis', globalConcurrency: 3 }))
      .rejects.toMatchObject({ code: 'WORKER_POOL_CONFIG_MISMATCH' });
    const bi = await registerPiAgentWorkerInstance({ ...input, workerKind: 'bi_analysis' });
    expect(await hasLivePiAgentWorker('bi_analysis', poolKey)).toBe(true);
    await a.agentWorkerInstance.update({ where: { id: bi.id }, data: { leaseExpiresAt: new Date(0) } });
    expect(await hasLivePiAgentWorker('bi_analysis', poolKey)).toBe(false);
    await stopPiAgentWorkerInstance(legacyWorker);
    expect(await hasLivePiAgentWorker('project_generation', poolKey)).toBe(false);
  });

  it.each(['normal', 'expired', 'underreserved'])('settles %s reservations once across concurrent worker/maintenance clients', async (mode) => {
    const actor = await identity(), run = await claim(await pending(actor));
    const reserved = await createQuotaService(a).reserve({ actorUserId: actor.actorId,
      metric: 'llm.total_tokens.monthly', quantity: mode === 'underreserved' ? 1 : 20,
      idempotencyKey: biAgentTokenReservationKey(run.id), reservationTtlSeconds: 60 });
    expect(reserved.reservation).not.toBeNull();
    if (mode === 'expired') await a.quotaReservation.update({ where: { id: reserved.reservation!.id }, data: { expiresAt: new Date(0) } });
    await finish(run);
    await Promise.all([settleAgentRunUsage(a, run.id), settleAgentRunUsage(b, run.id)]);
    await settleAgentRunUsage(b, run.id);
    const events = await a.usageEvent.findMany({ where: { actorUserId: actor.actorId } });
    expect(events).toHaveLength(1); expect(events[0].quantity).toBe(11n); expect(events[0].projectId).toBeNull();
    const buckets = await a.usageBucket.findMany({ where: { actorUserId: actor.actorId } });
    expect(buckets.reduce((n, row) => n + row.used, 0n)).toBe(11n);
    expect(buckets.reduce((n, row) => n + row.reserved, 0n)).toBe(0n);
    expect((await a.quotaReservation.findUniqueOrThrow({ where: { id: reserved.reservation!.id } })).status).not.toBe('active');
  });

  it('releases zero-token terminal reservations and refuses premature settlement', async () => {
    const actor = await identity(), run = await claim(await pending(actor));
    const reserved = await createQuotaService(a).reserve({ actorUserId: actor.actorId,
      metric: 'llm.total_tokens.monthly', quantity: 20, idempotencyKey: biAgentTokenReservationKey(run.id) });
    await expect(settleAgentRunUsage(b, run.id)).rejects.toThrow('terminal');
    await finish(run, 0); await settleAgentRunUsage(a, run.id); await settleAgentRunUsage(b, run.id);
    expect(await a.usageEvent.count({ where: { actorUserId: actor.actorId } })).toBe(0);
    expect((await a.quotaReservation.findUniqueOrThrow({ where: { id: reserved.reservation!.id } })).status).toBe('released');
  });

  it('uses one actor limit across BI and legacy generation in both directions', async () => {
    const actor = await identity(), first = await claim(await pending(actor)), old = await legacy(actor);
    await expect(claimPiAgentGenerationJob(old)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await finish(first, 0); await claimPiAgentGenerationJob(old);
    const secondId = await pending(actor);
    await expect(claim(secondId, b)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await a.agentRun.findUnique({ where: { id: secondId } })).toMatchObject({ status: 'pending', fencingToken: 0 });
  });

  it('serializes two different BI scopes on the same actor across clients', async () => {
    const actor = await identity(), x = await pending(actor), y = await pending(actor);
    const result = await Promise.allSettled([claim(x), claim(y, b)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await a.agentRun.count({ where: { actorUserId: actor.actorId, status: 'running' } })).toBe(1);
    expect(await a.agentRun.count({ where: { actorUserId: actor.actorId, status: 'pending' } })).toBe(1);
  });
});
