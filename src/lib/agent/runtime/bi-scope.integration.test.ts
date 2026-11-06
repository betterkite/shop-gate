import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type AgentExecutionScope } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectPiAgentSchemaReadiness } from '@/lib/db/pi-agent-schema-readiness';
import { PrismaAgentRuntimeRepository } from './prisma-repository';
import type { AgentRunRecord, CreateAgentRunInput } from './types';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_scope_${randomUUID().replaceAll('-', '')}`;
const pageScope = { view: 'overview', dateFrom: '2026-09-01', dateTo: '2026-09-30' };
const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cachedInputTokens: 0, cacheMissInputTokens: 0, reasoningTokens: 0 };
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fence = (run: AgentRunRecord) => ({ runId: run.id, expectedVersion: run.version,
  leaseOwner: run.leaseOwner!, fencingToken: run.fencingToken,
  workspaceFencingToken: run.workspaceFencingToken });

describe.skipIf(!databaseUrl)('BI execution scopes (real PostgreSQL)', () => {
  let a: PrismaClient;
  let b: PrismaClient;
  let repository: PrismaAgentRuntimeRepository;
  let otherRepository: PrismaAgentRuntimeRepository;
  let sequence = 0;
  const users: string[] = [];
  const projects: string[] = [];
  const scopes: string[] = [];
  const unique = () => `${prefix}:${++sequence}`;

  async function user() {
    const id = unique();
    await a.authUser.create({ data: { id, name: 'BI scope test', email: `${id}@example.invalid` } });
    users.push(id);
    return id;
  }

  async function scope(ownerUserId: string, datasetId = 'same-dataset') {
    const row = await a.agentExecutionScope.create({ data: {
      kind: 'bi_dataset', workspaceId: `account:${ownerUserId}`, datasetId, ownerUserId,
    } });
    scopes.push(row.id);
    return row;
  }

  async function request(executionScope: AgentExecutionScope, actorUserId: string) {
    const conversation = await a.biAgentConversation.create({ data: {
      executionScopeId: executionScope.id, actorUserId, title: '当前经营情况',
    } });
    return a.biAgentRequest.create({ data: {
      conversationId: conversation.id, executionScopeId: executionScope.id, actorUserId,
      idempotencyKey: unique(), instruction: '分析当前范围的净销售额，并给出数据来源。',
      inputHash: 'a'.repeat(64), pageScope,
      datasetVersion: 2, model: 'deepseek-v4-flash',
    } });
  }

  function input(executionScopeId: string, biRequestId: string,
    overrides: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
    return { id: unique(), biRequestId, workspaceKey: hash(`bi-runtime:${executionScopeId}`),
      provider: 'deepseek', model: 'deepseek-v4-flash', frameworkVersion: 'pi-agent:bi-test',
      buildRevision: 'test:bi-scope', profileHash: hash('profile'), promptHash: hash('prompt'),
      toolHash: hash('tools'), skillHash: hash('skills'), workspaceHash: hash('scope'),
      leaseOwner: unique(), leaseExpiresAt: new Date(Date.now() + 120_000), ...overrides };
  }

  beforeAll(async () => {
    a = new PrismaClient({ datasourceUrl: databaseUrl! });
    b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
    repository = new PrismaAgentRuntimeRepository(a);
    otherRepository = new PrismaAgentRuntimeRepository(b);
  });

  afterAll(async () => {
    try {
      // Clean only identities owned by this test, preserving all other fixtures.
      await a.agentExecutionScope.deleteMany({ where: { id: { in: scopes } } });
      await a.authUser.deleteMany({ where: { id: { in: users } } });
      await a.project.deleteMany({ where: { id: { in: projects } } });
    } finally { await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });

  it('uses real account owners without creating filesystem Projects', async () => {
    const firstUser = await user();
    const secondUser = await user();
    const first = await scope(firstUser);
    const second = await scope(secondUser);
    const [firstRequest, secondRequest] = await Promise.all([
      request(first, firstUser), request(second, secondUser),
    ]);
    const runs = await Promise.all([
      repository.createRun(input(first.id, firstRequest.id)),
      otherRepository.createRun(input(second.id, secondRequest.id)),
    ]);
    expect(runs.map((run) => run.projectId)).toEqual([null, null]);
    expect(runs.map((run) => run.executionScopeId)).toEqual([first.id, second.id]);
    expect(await a.agentRun.findUnique({ where: { id: runs[0].id } })).toMatchObject({
      actorUserId: firstUser, biRequestId: firstRequest.id, requestId: null,
    });
    expect(await a.project.count({ where: { id: { in: [first.workspaceId, second.workspaceId] } } })).toBe(0);
    expect(await repository.getWorkspaceLease(first.workspaceId)).toBeNull();
    expect(await repository.getExecutionScopeLease(first.id)).toMatchObject({ activeRunId: runs[0].id });
  });

  it('rejects nonexistent owners, mismatched account identities and mutable scope identity', async () => {
    const actor = await user();
    await expect(a.agentExecutionScope.create({ data: {
      kind: 'bi_dataset', workspaceId: 'account:nonexistent', datasetId: 'test', ownerUserId: 'nonexistent',
    } })).rejects.toThrow();
    await expect(a.agentExecutionScope.create({ data: {
      kind: 'bi_dataset', workspaceId: 'account:someone-else', datasetId: 'test', ownerUserId: actor,
    } })).rejects.toThrow();
    const owned = await scope(actor);
    await expect(a.agentExecutionScope.update({ where: { id: owned.id }, data: { datasetId: 'another' } }))
      .rejects.toThrow();
    await expect(a.biAgentConversation.create({ data: {
      executionScopeId: owned.id, actorUserId: await user(), title: 'Cross-account attempt',
    } })).rejects.toThrow();
  });

  it('binds shared conversations privately and prevents cross-scope or cross-actor requests', async () => {
    const actor = await user();
    const otherActor = await user();
    const projectId = unique();
    await a.project.create({ data: { id: projectId, name: 'Shared BI scope' } });
    projects.push(projectId);
    const shared = await a.agentExecutionScope.create({ data: {
      kind: 'bi_dataset', workspaceId: projectId, sharedProjectId: projectId, datasetId: 'shared-data',
    } });
    scopes.push(shared.id);
    const first = await request(shared, actor);
    const second = await request(shared, otherActor);
    const personal = await scope(actor);
    const data = { ...first, id: undefined, pageScope };
    await expect(a.biAgentRequest.create({ data: { ...data, id: unique(),
      idempotencyKey: unique(), actorUserId: otherActor } })).rejects.toThrow();
    await expect(a.biAgentRequest.create({ data: { ...data, id: unique(),
      idempotencyKey: unique(), executionScopeId: personal.id } })).rejects.toThrow();
    const run = await repository.createRun(input(shared.id, first.id));
    expect(await a.agentRun.findMany({ where: { projectId, id: run.id } })).toEqual([]);
    await expect(a.agentRun.update({ where: { id: run.id }, data: {
      biRequestId: second.id, actorUserId: otherActor,
    } })).rejects.toThrow();
    await expect(a.agentRun.update({ where: { id: run.id }, data: { projectId } })).rejects.toThrow();
  });

  it('keeps request scope/version/model immutable and rejects invalid execution binding', async () => {
    const actor = await user();
    const owned = await scope(actor);
    const envelope = await request(owned, actor);
    await expect(a.biAgentRequest.update({ where: { id: envelope.id }, data: { datasetVersion: 3 } }))
      .rejects.toThrow();
    const data = { ...envelope, id: undefined, pageScope };
    await expect(a.biAgentRequest.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await expect(repository.createRun(input(owned.id, envelope.id, { model: 'different-model' })))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(repository.createRun(input(owned.id, envelope.id, { workspaceKey: hash('foreign-scope') })))
      .rejects.toMatchObject({ code: 'WORKSPACE_BINDING_CONFLICT' });
    await expect(repository.createRun(input(owned.id, 'absent-request')))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(repository.createRun(input(owned.id, envelope.id, { projectId: 'fake-project' })))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await a.agentRun.count({ where: { executionScopeId: owned.id } })).toBe(0);
  });

  it('serializes BI runs across clients and fences the expired holder', async () => {
    const actor = await user();
    const owned = await scope(actor);
    const first = await request(owned, actor);
    const second = await request(owned, actor);
    const outcomes = await Promise.allSettled([
      repository.createRun(input(owned.id, first.id)), otherRepository.createRun(input(owned.id, second.id)),
    ]);
    const wins = outcomes.filter((x): x is PromiseFulfilledResult<AgentRunRecord> => x.status === 'fulfilled');
    const losses = outcomes.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].reason).toMatchObject({ code: 'WORKSPACE_BUSY' });
    const old = wins[0].value;
    await a.agentWorkspaceLease.update({ where: { executionScopeId: owned.id }, data: { leaseExpiresAt: new Date(0) } });
    await a.agentRun.update({ where: { id: old.id }, data: { leaseExpiresAt: new Date(0) } });
    const replacement = await otherRepository.createRun(input(owned.id, second.id));
    expect(replacement.workspaceFencingToken).toBe(old.workspaceFencingToken + 1);
    expect(await repository.getRun(old.id)).toMatchObject({ status: 'interrupted' });
    await expect(repository.heartbeat({ ...fence(old), leaseExpiresAt: new Date(Date.now() + 120_000) }))
      .rejects.toThrow();
    expect(await repository.getExecutionScopeLease(owned.id)).toMatchObject({ activeRunId: replacement.id });
  });

  it('retains events, query receipts and checkpoints across clients and completes cancellation', async () => {
    const actor = await user();
    const owned = await scope(actor);
    const envelope = await request(owned, actor);
    let run = await repository.createRun(input(owned.id, envelope.id));
    run = (await repository.appendEvent({ ...fence(run), sequence: 1, eventId: unique(),
      eventType: 'analysis_evidence', payload: { datasetVersion: 2, netSales: '164.0000' }, occurredAt: new Date() })).run;
    run = (await repository.saveCheckpoint({ ...fence(run), sequence: 1, turn: 1,
      boundary: 'model_turn_completed', publicState: { datasetVersion: 2, evidenceIds: ['query-1'] },
      stateHash: hash('checkpoint'), stateVersion: 1 })).run;
    const operationId = unique();
    run = (await repository.prepareToolExecution({ ...fence(run), operationId,
      toolCallId: unique(), toolName: 'bi_query', inputHash: hash('query'), effect: 'read', idempotency: 'intrinsic' })).run;
    run = (await repository.completeToolExecution({ ...fence(run), operationId, status: 'succeeded',
      resultReceipt: { datasetVersion: 2, netSales: '164.0000', evidenceId: 'query-1' } })).run;
    expect(await otherRepository.listEventsAfter(run.id, 0)).toHaveLength(1);
    expect(await otherRepository.getLatestCheckpoint(run.id)).toMatchObject({ publicState: { datasetVersion: 2 } });
    expect(await otherRepository.getToolExecution(operationId)).toMatchObject({ resultReceipt: { netSales: '164.0000' } });
    const cancelled = await otherRepository.completeRun({ ...fence(run), status: 'cancelled', turnCount: 1, usage: zeroUsage });
    expect(cancelled.status).toBe('cancelled');
    expect(await repository.getExecutionScopeLease(owned.id)).toMatchObject({ status: 'free', activeRunId: null });
    expect(await repository.getRun(run.id)).toMatchObject({ status: 'cancelled', executionScopeId: owned.id });
  });

  it('forbids filesystem mutation even if a caller accidentally registers a legacy tool', async () => {
    const actor = await user();
    const owned = await scope(actor);
    const envelope = await request(owned, actor);
    const run = await repository.createRun(input(owned.id, envelope.id));
    await expect(repository.prepareToolExecution({ ...fence(run), operationId: unique(), toolCallId: unique(),
      toolName: 'write_file', inputHash: hash('file'), effect: 'workspace_write', idempotency: 'operation_key', idempotencyKey: unique() }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    let mutated = false;
    await expect(repository.commitWorkspaceMutation({ ...fence(run), operationId: unique() }, async () => { mutated = true; }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(mutated).toBe(false);
    expect(await a.agentToolExecution.count({ where: { runId: run.id } })).toBe(0);
  });

  it('requires explicit BI reconciliation scope and cannot silently resume a provider turn', async () => {
    const actor = await user();
    const owned = await scope(actor);
    const envelope = await request(owned, actor);
    const run = await repository.createRun(input(owned.id, envelope.id));
    await a.agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
    await a.agentWorkspaceLease.update({ where: { executionScopeId: owned.id }, data: { leaseExpiresAt: new Date(0) } });
    expect((await repository.listReconciliationCandidates()).some((candidate) => candidate.run.id === run.id)).toBe(false);
    expect((await otherRepository.listReconciliationCandidates({ executionScopeId: owned.id })).map((x) => x.run.id))
      .toEqual([run.id]);
    const recovered = await otherRepository.claimLease({ runId: run.id, expectedVersion: run.version,
      leaseOwner: unique(), leaseExpiresAt: new Date(Date.now() + 120_000) });
    expect(recovered.status).toBe('reconciling');
    await otherRepository.completeRun({ ...fence(recovered), status: 'interrupted', turnCount: 0, usage: zeroUsage });
    expect(await repository.getRun(run.id)).toMatchObject({ status: 'interrupted' });
  });

  it('checks the actual migrated catalog and fails closed if an ownership guard is disabled', async () => {
    expect(await inspectPiAgentSchemaReadiness(a)).toMatchObject({ ready: true, issues: [] });
    // DDL is rolled back on this owned DB; no permanent drift or disabled guard.
    await expect(a.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE bi_agent_requests DISABLE TRIGGER bi_agent_requests_immutable');
      const report = await inspectPiAgentSchemaReadiness(tx);
      expect(report.ready).toBe(false);
      expect(report.issues).toContainEqual(expect.objectContaining({ code: 'MISSING_OR_DISABLED_TRIGGER' }));
      throw new Error('rollback-test-only');
    })).rejects.toThrow('rollback-test-only');
    expect((await inspectPiAgentSchemaReadiness(a)).ready).toBe(true);
  });
  it('reads and enforces the real session-reference check rather than only synthetic catalog fixtures', async () => {
    await expect(a.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE bi_agent_requests DROP CONSTRAINT bi_agent_requests_session_reference');
      const report = await inspectPiAgentSchemaReadiness(tx);
      expect(report.ready).toBe(false);
      expect(report.issues).toContainEqual(expect.objectContaining({ code: 'MISSING_CHECK_CONSTRAINT',
        objectName: 'public.bi_agent_requests.bi_agent_requests_session_reference' }));
      throw new Error('rollback-session-check-test');
    })).rejects.toThrow('rollback-session-check-test');
    expect((await inspectPiAgentSchemaReadiness(a)).ready).toBe(true);
  });

});
