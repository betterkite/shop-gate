import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PiAgentDurableRunSession } from '@/lib/services/pi-agent-run-store';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { recheckBiAgentSession, type BiAgentAuthority } from './authorization';
import { authorizeBiAgentRun, cancelBiAgentQuestion, listBiAgentQuestions, submitBiAgentQuestion } from './requests';
import { biAgentPageScopeSchema } from './contracts';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_inbox_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!databaseUrl)('BI assistant durable inbox (real PostgreSQL)', () => {
  let a: PrismaClient, b: PrismaClient;
  let sequence = 0;
  const users: string[] = [], projects: string[] = [];
  const unique = () => `${prefix}:${++sequence}`;
  const resolver = vi.fn(async () => biAgentPageScopeSchema.parse({ module: 'overview', start: '2026-09-01', end: '2026-09-30' }));
  const deps = () => ({ client: a, resolvePage: resolver });
  async function identity(): Promise<BiAgentAuthority> {
    const id = unique(), sessionId = unique(); users.push(id);
    await a.authUser.create({ data: { id, name: 'Owned BI inbox test', email: `${id}@example.invalid` } });
    await a.authSession.create({ data: { id: sessionId, token: unique(), userId: id,
      expiresAt: new Date(Date.now() + 3_600_000) } });
    return { actorId: id, sessionId, workspaceId: `account:${id}` };
  }
  const question = (change = {}) => ({ dataset_id: 'identical-dataset', dataset_version: 2,
    conversation_id: randomUUID(), expected_conversation_version: 0, idempotency_key: unique(),
    instruction: '当前范围的净销售额是多少？', model: 'deepseek-v4-flash', page_scope: { module: 'overview' }, ...change });
  beforeAll(async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local'); vi.stubEnv('SHOPGATE_AUTH_SECRET', 'owned-inbox-test-auth-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'unused-inbox-test-credential'); vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1');
    a = new PrismaClient({ datasourceUrl: databaseUrl! }); b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
  });
  afterAll(async () => {
    try {
      await a.agentExecutionScope.deleteMany({ where: { OR: [{ ownerUserId: { in: users } }, { sharedProjectId: { in: projects } }] } });
      await a.project.deleteMany({ where: { id: { in: projects } } });
      await a.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { vi.unstubAllEnvs(); await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });

  it('atomically accepts a private question and pending run, deriving actor from an actual session', async () => {
    const actor = await identity(), q = question();
    const accepted = await submitBiAgentQuestion(actor, q, deps());
    expect(accepted).toMatchObject({ conversation_version: 1, replayed: false,
      request: { instruction: q.instruction, datasetVersion: 2, runs: [{ status: 'pending', version: 0 }] } });
    const stored = await a.biAgentRequest.findUniqueOrThrow({ where: { id: accepted.request.id } });
    expect(stored).toMatchObject({ actorUserId: actor.actorId, sessionId: actor.sessionId,
      pageScope: { start: '2026-09-01', end: '2026-09-30' } });
    expect(accepted.request).not.toHaveProperty('sessionId');
    expect(await a.project.count({ where: { id: actor.workspaceId } })).toBe(0);
    expect((await authorizeBiAgentRun(accepted.request.runs[0].id, b)).authority).toEqual(actor);
    await expect(a.biAgentRequest.update({ where: { id: stored.id }, data: { sessionId: 'replacement' } })).rejects.toThrow();
  });

  it('serializes concurrent identical submissions across clients into one request and one run', async () => {
    const actor = await identity(), q = question();
    const results = await Promise.all([
      submitBiAgentQuestion(actor, q, deps()), submitBiAgentQuestion(actor, q, { client: b, resolvePage: resolver }),
    ]);
    expect(results[0].request.id).toBe(results[1].request.id);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await a.biAgentRequest.count({ where: { conversationId: q.conversation_id } })).toBe(1);
    expect(await a.agentRun.count({ where: { biRequestId: results[0].request.id } })).toBe(1);
    resolver.mockClear();
    expect((await submitBiAgentQuestion(actor, q, deps())).replayed).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects key/content, stale-version and active-turn conflicts without inserting another run', async () => {
    const actor = await identity(), q = question();
    await submitBiAgentQuestion(actor, q, deps());
    for (const change of [{ instruction: 'another question' }, { dataset_version: 3 }, { model: 'local_qwen:qwen3.5-9b-q5km' }]) {
      await expect(submitBiAgentQuestion(actor, { ...q, ...change }, deps())).rejects.toMatchObject({ code: 'BI_AGENT_CONFLICT' });
    }
    await expect(submitBiAgentQuestion(actor, { ...q, idempotency_key: unique() }, deps())).rejects.toMatchObject({ code: 'BI_AGENT_CONFLICT' });
    await expect(submitBiAgentQuestion(actor, { ...q, expected_conversation_version: 1, idempotency_key: unique() }, deps()))
      .rejects.toMatchObject({ code: 'BI_AGENT_BUSY' });
    expect(await a.biAgentRequest.count({ where: { conversationId: q.conversation_id } })).toBe(1);
  });

  it('isolates same-name datasets and denies guessed conversations, runs and account identities', async () => {
    const first = await identity(), second = await identity(), q = question();
    const accepted = await submitBiAgentQuestion(first, q, deps());
    await expect(submitBiAgentQuestion(second, q, deps())).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(listBiAgentQuestions(second, q.conversation_id, 1, a)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(cancelBiAgentQuestion(second, accepted.request.runs[0].id, a)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(recheckBiAgentSession(second.sessionId, first.workspaceId, 'run', a)).rejects.toMatchObject({ status: 403 });
    const other = await submitBiAgentQuestion(second, question(), deps());
    const [x, y] = await a.agentRun.findMany({ where: { id: { in: [accepted.request.runs[0].id, other.request.runs[0].id] } }, orderBy: { createdAt: 'asc' } });
    expect(x.executionScopeId).not.toBe(y.executionScopeId);
  });

  it('revokes worker authority on logout, password change, disabled account and explicit capability denial', async () => {
    const actor = await identity(), accepted = await submitBiAgentQuestion(actor, question(), deps());
    const runId = accepted.request.runs[0].id;
    await a.authUser.update({ where: { id: actor.actorId }, data: { banned: true } });
    await expect(authorizeBiAgentRun(runId, b)).rejects.toMatchObject({ status: 403 });
    await a.authUser.update({ where: { id: actor.actorId }, data: { banned: false, passwordChangedAt: new Date(Date.now() + 10) } });
    await expect(authorizeBiAgentRun(runId, b)).rejects.toMatchObject({ status: 403 });
    await a.authUser.update({ where: { id: actor.actorId }, data: { passwordChangedAt: null } });
    await a.userPermissionOverride.create({ data: { userId: actor.actorId, permissionKey: 'commerce.operation.run', effect: 'deny' } });
    await expect(authorizeBiAgentRun(runId, b)).rejects.toMatchObject({ status: 403 });
    // Read history/cancel remain available to the owner after model capability revocation.
    expect((await listBiAgentQuestions(actor, accepted.conversation_id, 1, a)).total).toBe(1);
    await a.authSession.delete({ where: { id: actor.sessionId } });
    await expect(authorizeBiAgentRun(runId, b)).rejects.toMatchObject({ status: 403 });
    expect(await a.biAgentRequest.findUnique({ where: { id: accepted.request.id } })).not.toBeNull();
  });

  it('rechecks shared membership and keeps each shared conversation private', async () => {
    const first = await identity(), second = await identity(), workspace = unique(); projects.push(workspace);
    await a.project.create({ data: { id: workspace, name: 'Owned shared BI inbox', ownerId: first.actorId,
      memberships: { create: { userId: second.actorId, role: 'viewer' } } } });
    const owner = { ...first, workspaceId: workspace }, viewer = { ...second, workspaceId: workspace };
    const accepted = await submitBiAgentQuestion(viewer, question(), deps());
    await expect(listBiAgentQuestions(owner, accepted.conversation_id, 1, a)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(recheckBiAgentSession(viewer.sessionId, workspace, 'manage', a)).rejects.toMatchObject({ status: 403 });
    await a.projectMembership.deleteMany({ where: { projectId: workspace, userId: second.actorId } });
    await expect(authorizeBiAgentRun(accepted.request.runs[0].id, b)).rejects.toMatchObject({ status: 403 });
  });

  it('claims the existing queue row once and never resumes a started run as another provider execution', async () => {
    const actor = await identity(), accepted = await submitBiAgentQuestion(actor, question(), deps());
    const runId = accepted.request.runs[0].id;
    const repository = new PrismaAgentRuntimeRepository(a), other = new PrismaAgentRuntimeRepository(b);
    const results = await Promise.allSettled([
      PiAgentDurableRunSession.claimPending({ repository, runId, expectedVersion: 0, heartbeatEnabled: false }),
      PiAgentDurableRunSession.claimPending({ repository: other, runId, expectedVersion: 0, heartbeatEnabled: false }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((r) => r.status === 'fulfilled');
    if (!success || success.status !== 'fulfilled') throw new Error('No worker claimed pending row');
    const session = success.value;
    expect(session.run).toMatchObject({ id: runId, status: 'running', fencingToken: 1 });
    await expect(PiAgentDurableRunSession.claimPending({ repository, runId,
      expectedVersion: session.run.version, heartbeatEnabled: false })).rejects.toThrow('unstarted pending');
    await session.interrupt({ code: 'TEST_REPLAN_REQUIRED' }); await session.close();
    expect(await a.agentRun.count({ where: { biRequestId: accepted.request.id } })).toBe(1);
  });

  it('persists cancellation before dispatch and during a claimed execution without losing its fence', async () => {
    const actor = await identity(), accepted = await submitBiAgentQuestion(actor, question(), deps());
    const runId = accepted.request.runs[0].id;
    expect(await cancelBiAgentQuestion(actor, runId, b)).toMatchObject({ status: 'cancelled' });
    await expect(PiAgentDurableRunSession.claimPending({ repository: new PrismaAgentRuntimeRepository(a),
      runId, expectedVersion: 0, heartbeatEnabled: false })).rejects.toThrow();
    const next = await submitBiAgentQuestion(actor, question(), deps());
    const session = await PiAgentDurableRunSession.claimPending({ repository: new PrismaAgentRuntimeRepository(a),
      runId: next.request.runs[0].id, expectedVersion: 0, heartbeatEnabled: false });
    expect(await cancelBiAgentQuestion(actor, session.run.id, b)).toMatchObject({ status: 'running', version: session.run.version });
    await expect(authorizeBiAgentRun(session.run.id, b)).rejects.toMatchObject({ code: 'BI_AGENT_CANCELLED' });
    await session.assertWorkspaceFence();
    await session.interrupt({ code: 'TEST_CANCEL_DRAIN' }); await session.close();
  });

  it('reads all persisted turns with 20-row stable pagination across clients', async () => {
    const actor = await identity(), q = question();
    for (let i = 0; i < 22; i++) {
      const accepted = await submitBiAgentQuestion(actor, { ...q, idempotency_key: unique(), expected_conversation_version: i }, deps());
      await cancelBiAgentQuestion(actor, accepted.request.runs[0].id, a);
    }
    const first = await listBiAgentQuestions(actor, q.conversation_id, 1, b);
    const second = await listBiAgentQuestions(actor, q.conversation_id, 2, b);
    expect([first.total, first.rows.length, second.rows.length]).toEqual([22, 20, 2]);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(22);
    expect(JSON.stringify(first)).not.toContain(actor.sessionId);
  });

  it('rejects stale or invalid authority and unavailable models before creating a request', async () => {
    const actor = await identity(), q = question();
    await a.authSession.update({ where: { id: actor.sessionId }, data: { expiresAt: new Date(0) } });
    await expect(submitBiAgentQuestion(actor, q, deps())).rejects.toMatchObject({ status: 403 });
    await a.authSession.update({ where: { id: actor.sessionId }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });
    vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '0');
    try { await expect(submitBiAgentQuestion(actor, q, deps())).rejects.toMatchObject({ code: 'BI_AGENT_MODEL_UNAVAILABLE' }); }
    finally { vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1'); }
    await expect(submitBiAgentQuestion(actor, { ...q, model: 'unknown' }, deps())).rejects.toThrow();
    expect(await a.biAgentConversation.findUnique({ where: { id: q.conversation_id } })).toBeNull();
  });
});
