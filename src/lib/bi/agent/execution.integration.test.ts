import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PiAgentModelEvent, PiAgentModelProvider, PiAgentModelRequest } from '@/lib/agent/types';
import { PiAgentRunEngine } from '@/lib/agent/pi/run-engine';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { PiAgentDurableRunSession } from '@/lib/services/pi-agent-run-store';
import { createQuotaService } from '@/lib/quota/service';
import { biAgentTokenReservationKey } from '@/lib/services/pi-agent-usage-settlement';
import { submitBiAgentQuestion, cancelBiAgentQuestion } from './requests';
import { biAgentPageScopeSchema } from './contracts';
import { executeBiAgentRun, failPendingBiAgentRun } from './execution';
import { publishBiAgentAnswer } from './completion';
import { recoverBiAgentExecutions } from './recovery';
import { readBiAgentAnswer, readBiAgentResultPage } from './results';
import { createBiAgentTools } from './tools';
import type { BiAgentAuthority } from './authorization';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_execution_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!databaseUrl)('BI engine and worker execution (real PostgreSQL; scripted model)', () => {
  let a: PrismaClient, b: PrismaClient; let seq = 0;
  const users: string[] = [];
  const unique = () => `${prefix}:${++seq}`;
  const scope = biAgentPageScopeSchema.parse({ module: 'overview', start: '2026-09-01', end: '2026-09-30' });
  async function identity(limit = 500_000) {
    const id = unique(), sessionId = unique(); users.push(id);
    await a.authUser.create({ data: { id, name: 'Owned execution test', email: `${id}@example.invalid` } });
    await a.authSession.create({ data: { id: sessionId, token: unique(), userId: id, expiresAt: new Date(Date.now() + 3_600_000) } });
    await a.userQuotaOverride.create({ data: { userId: id, metric: 'llm.total_tokens.monthly', limit: BigInt(limit), enforcement: 'hard', windowType: 'month' } });
    return { actorId: id, sessionId, workspaceId: `account:${id}` };
  }
  async function pending(authority?: BiAgentAuthority, conversationId = randomUUID(), version = 0, instruction = '列出全部商品净销售额') {
    const actor = authority ?? await identity();
    const accepted = await submitBiAgentQuestion(actor, { dataset_id: 'same-data', dataset_version: 2,
      conversation_id: conversationId, expected_conversation_version: version, idempotency_key: unique(),
      instruction, model: 'deepseek-v4-flash', page_scope: scope },
    { client: a, resolvePage: async () => scope });
    return { actor, id: accepted.request.runs[0].id, conversationId, version: accepted.conversation_version };
  }
  const read = vi.fn(async (actor: BiAgentAuthority, dataset: string, version: number, query: Record<string, unknown>) => ({
    workspace_id: actor.workspaceId, dataset_id: dataset, version, accounting_revision: version,
    algorithm_version: 'explicit-scripted-ledger-fixture', data_cutoff: '2026-09-30',
    range: { start: '2026-09-01', end: '2026-09-30', refund_basis: 'payment' },
    summary: { metrics: { net_sales: '25.00' }, quality: {} }, total: 25, page: Number(query.page), page_size: 100,
    rows: Array.from({ length: 25 }, (_, i) => ({ key: `p${i}`, name: `商品${i}`, metrics: { net_sales: '1.00' }, quality: {} })),
  }));
  function providerFor(runId: string) {
    const requests: PiAgentModelRequest[] = [];
    const provider: PiAgentModelProvider = { name: 'deepseek', async *complete(request): AsyncGenerator<PiAgentModelEvent> {
      requests.push(request);
      const evidence = await a.biAgentResult.findFirst({ where: { runId, complete: true } });
      if (evidence) expect(JSON.stringify(request.messages)).toContain(evidence.id);
      const name = evidence ? 'submit_answer' : 'query_ledger';
      const input = evidence ? { kind: 'answer', text: '当前范围净销售额25元，25个商品见完整表格。',
        evidence_ids: [evidence.id], views: [{ result_id: evidence.id, kind: 'table', metric: 'net_sales' }] }
        : { dimension: 'product', metrics: ['net_sales'] };
      yield { type: 'response_start', responseId: unique(), model: request.model };
      yield { type: 'tool_call_delta', index: 0, id: unique(), nameDelta: name, argumentsDelta: JSON.stringify(input) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      yield { type: 'finish', reason: 'tool_calls' };
    } };
    return { provider, requests };
  }
  const execute = (id: string, provider: PiAgentModelProvider, signal = new AbortController().signal) =>
    executeBiAgentRun({ runId: id, expectedVersion: 0, leaseOwner: unique(), signal, assertCapacity: () => undefined },
      { client: a, read, provider });
  async function recoverOwned(runId: string, client = a) {
    const run = await client.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { executionScopeId: true } });
    return recoverBiAgentExecutions(client, run.executionScopeId);
  }
  async function candidate() {
    const fixture = await pending(), repository = new PrismaAgentRuntimeRepository(a);
    const session = await PiAgentDurableRunSession.claimPending({ repository, runId: fixture.id, expectedVersion: 0, heartbeatEnabled: false });
    const run = session.run, fence = { runId: run.id, leaseOwner: run.leaseOwner!, fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken };
    const { provider } = providerFor(run.id);
    const engine = new PiAgentRunEngine({ provider, model: 'deepseek-v4-flash',
      tools: createBiAgentTools(fence, { client: a, read }), requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: false, maxTurns: 4, timeoutMs: 15_000 });
    const result = await engine.run({ runId: run.id, messages: [{ role: 'user', content: '读取商品净销售额' }] },
      { durableSink: (event) => session.record(event) });
    await session.close(); expect(result.status).toBe('completed');
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('candidate_complete');
    return fixture;
  }
  beforeAll(async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local'); vi.stubEnv('SHOPGATE_AUTH_SECRET', 'owned-execution-auth-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'unused-scripted-execution-credential'); vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1');
    a = new PrismaClient({ datasourceUrl: databaseUrl! }); b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
  });
  afterAll(async () => {
    try {
      await a.agentExecutionScope.deleteMany({ where: { ownerUserId: { in: users } } });
      await a.usageEvent.deleteMany({ where: { actorUserId: { in: users } } });
      await a.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { vi.unstubAllEnvs(); await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });

  it('runs real engine/tools, publishes complete paged evidence, meters once and carries display history into follow-up', async () => {
    const fixture = await pending(), model = providerFor(fixture.id);
    expect(await execute(fixture.id, model.provider)).toMatchObject({ status: 'completed' });
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[0].messages)).toContain('previous_equal_length_period');
    expect(JSON.stringify(model.requests[0].messages)).toContain('2026-08-02');
    expect(JSON.stringify(model.requests[1].messages)).toContain('display_preview');
    const result = await readBiAgentAnswer(fixture.actor, fixture.id, b);
    expect(result.answer?.text).toContain('25');
    const id = result.answer!.evidence_ids[0];
    expect((await readBiAgentResultPage(fixture.actor, fixture.id, id, 1, b)).rows).toHaveLength(20);
    expect((await readBiAgentResultPage(fixture.actor, fixture.id, id, 2, b)).rows).toHaveLength(5);
    const reservation = await a.quotaReservation.findUniqueOrThrow({ where: { idempotencyKey: biAgentTokenReservationKey(fixture.id) } });
    expect(reservation.status).toBe('settled');
    expect((await a.usageEvent.findMany({ where: { sourceId: fixture.id } })).map((e) => e.quantity)).toEqual([24n]);
    await expect(execute(fixture.id, model.provider)).rejects.toThrow(); expect(model.requests).toHaveLength(2);
    const next = await pending(fixture.actor, fixture.conversationId, fixture.version, '继续比较这些商品');
    const nextModel = providerFor(next.id); await execute(next.id, nextModel.provider);
    expect(JSON.stringify(nextModel.requests[0].messages)).toContain('当前范围净销售额25元');
    expect(JSON.stringify(nextModel.requests[0].messages)).toContain('historical_version');
  }, 30_000);

  it.each(['cancel', 'logout'])('aborts an in-flight provider on %s without publishing an answer', async (mode) => {
    const fixture = await pending(); let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const provider: PiAgentModelProvider = { name: 'deepseek', async *complete(request) {
      entered(); yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } };
      await new Promise<void>((_resolve, reject) => {
        const stop = () => { aborted = true; reject(new Error('owned provider aborted')); };
        request.signal?.addEventListener('abort', stop, { once: true });
        if (request.signal?.aborted) stop();
      });
    } };
    const execution = execute(fixture.id, provider); await ready;
    if (mode === 'cancel') await cancelBiAgentQuestion(fixture.actor, fixture.id, b);
    else await b.authSession.delete({ where: { id: fixture.actor.sessionId } });
    await execution; expect(aborted).toBe(true);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: fixture.id } })).status).not.toBe('completed');
    expect(await a.biAgentAnswer.findUnique({ where: { runId: fixture.id } })).toBeNull();
    expect((await a.quotaReservation.findUniqueOrThrow({ where: { idempotencyKey: biAgentTokenReservationKey(fixture.id) } })).status).not.toBe('active');
  }, 15_000);

  it('does not call a provider without reserved quota or with changed queue provenance', async () => {
    const fixture = await pending(await identity(1)), model = providerFor(fixture.id);
    await expect(execute(fixture.id, model.provider)).rejects.toThrow(); expect(model.requests).toHaveLength(0);
    const changed = await pending();
    await a.agentRun.update({ where: { id: changed.id }, data: { promptHash: `sha256:${'a'.repeat(64)}` } });
    await expect(execute(changed.id, model.provider)).rejects.toThrow('BI_AGENT_RUNTIME_CHANGED');
    await failPendingBiAgentRun(changed.id, 0, 'BI_AGENT_RUNTIME_CHANGED', a);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: changed.id } })).status).toBe('failed');
    expect(model.requests).toHaveLength(0);
  });

  it('recovers a persisted candidate once without another model call', async () => {
    const fixture = await candidate();
    expect((await readBiAgentAnswer(fixture.actor, fixture.id, b)).answer).toBeNull();
    await Promise.all([recoverOwned(fixture.id, a), recoverOwned(fixture.id, b)]);
    expect((await readBiAgentAnswer(fixture.actor, fixture.id, b)).status).toBe('completed');
    expect(await a.usageEvent.count({ where: { sourceId: fixture.id } })).toBe(1);
    await recoverOwned(fixture.id, b);
    expect(await a.usageEvent.count({ where: { sourceId: fixture.id } })).toBe(1);
  });

  it.each(['cancel', 'logout'])('does not publish a persisted candidate after %s', async (mode) => {
    const fixture = await candidate();
    if (mode === 'cancel') await cancelBiAgentQuestion(fixture.actor, fixture.id, b);
    else await b.authSession.delete({ where: { id: fixture.actor.sessionId } });
    await publishBiAgentAnswer(fixture.id, b);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: fixture.id } })).status).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
  });

  it('keeps scoped maintenance away from another account candidate and settlement', async () => {
    const owned = await candidate(), other = await candidate();
    await recoverOwned(owned.id, b);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: owned.id } })).status).toBe('completed');
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('candidate_complete');
    expect(await a.usageEvent.count({ where: { sourceId: other.id } })).toBe(0);
    await recoverOwned(other.id, b);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('completed');
  });

  it('rejects a candidate without a successful structured-answer tool receipt', async () => {
    const fixture = await pending(), repository = new PrismaAgentRuntimeRepository(a);
    const session = await PiAgentDurableRunSession.claimPending({ repository, runId: fixture.id, expectedVersion: 0, heartbeatEnabled: false });
    const run = session.run; await session.close();
    await repository.completeRun({ runId: run.id, expectedVersion: run.version, leaseOwner: run.leaseOwner!,
      fencingToken: run.fencingToken, workspaceFencingToken: run.workspaceFencingToken, status: 'candidate_complete',
      turnCount: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cachedInputTokens: 0, cacheMissInputTokens: 0, reasoningTokens: 0 } });
    expect(await publishBiAgentAnswer(run.id, b)).toEqual({ status: 'failed' });
    expect((await readBiAgentAnswer(fixture.actor, run.id, a)).answer).toBeNull();
  });

  it('interrupts expired BI execution, releases zero-token reservation, and leaves unstarted inbox rows pending', async () => {
    const fixture = await pending(), repository = new PrismaAgentRuntimeRepository(a);
    const session = await PiAgentDurableRunSession.claimPending({ repository, runId: fixture.id, expectedVersion: 0, heartbeatEnabled: false });
    const run = session.run; await session.close();
    const untouched = await pending(fixture.actor);
    await createQuotaService(a).reserve({ actorUserId: fixture.actor.actorId, metric: 'llm.total_tokens.monthly', quantity: 10,
      idempotencyKey: biAgentTokenReservationKey(run.id), reservationTtlSeconds: 120 });
    await a.agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
    await a.agentWorkspaceLease.update({ where: { executionScopeId: run.executionScopeId }, data: { leaseExpiresAt: new Date(0) } });
    await recoverOwned(fixture.id, b);
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('interrupted');
    expect((await a.agentRun.findUniqueOrThrow({ where: { id: untouched.id } })).status).toBe('pending');
    expect((await a.quotaReservation.findUniqueOrThrow({ where: { idempotencyKey: biAgentTokenReservationKey(run.id) } })).status).toBe('released');
  });
});
