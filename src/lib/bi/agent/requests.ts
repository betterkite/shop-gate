import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { PI_AGENT_BUILD_REVISION, PI_AGENT_FRAMEWORK_VERSION } from '@/lib/agent/framework-identity';
import { getProjectLlmConfig } from '@/lib/config/llm';
import { hashPiAgentProvenance } from '@/lib/services/pi-agent-provenance';
import { recheckBiAgentSession, type BiAgentAuthority } from './authorization';
import { biAgentSubmissionSchema, biAgentPageScopeSchema, BiAgentProblem } from './contracts';
import { resolveBiAgentPage } from './ledger';

const ACTIVE = ['pending', 'running', 'reconciling', 'waiting'];
const notFound = () => new BiAgentProblem('BI_AGENT_NOT_FOUND', 404, '对话不存在或当前账号无权查看。');
const conflict = () => new BiAgentProblem('BI_AGENT_CONFLICT', 409, '对话或请求内容已变化，请刷新后重试。');
const runSelect = { id: true, status: true, version: true, createdAt: true,
  finishedAt: true, cancelRequestedAt: true, errorCode: true } as const;
const requestSelect = { id: true, instruction: true, model: true, datasetVersion: true,
  pageScope: true, createdAt: true, runs: { select: runSelect, orderBy: { createdAt: 'desc' as const } } } as const;
const digest = (value: unknown) => `sha256:${hashPiAgentProvenance(value)}`;

type Dependencies = {
  client?: PrismaClient;
  resolvePage?: typeof resolveBiAgentPage;
};

/**
 * Transactional inbox: a request and exactly one pending physical run commit
 * together. No model starts in an HTTP response or unleased background Promise.
 */
export async function submitBiAgentQuestion(authority: BiAgentAuthority, raw: unknown,
  dependencies: Dependencies = {}) {
  const input = biAgentSubmissionSchema.parse(raw);
  const client = dependencies.client ?? prisma;
  if (input.workspace_id !== undefined && input.workspace_id !== authority.workspaceId) throw notFound();
  const checked = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'run', client);
  if (checked.actorId !== authority.actorId) throw notFound();
  const inputHash = hashPiAgentProvenance({ ...input, workspace_id: checked.workspaceId });

  // Read-only replay avoids a second query/model charge and permits recovery of
  // the original request after a newer import. It still requires current access.
  const existing = await client.biAgentRequest.findFirst({ where: {
    conversationId: input.conversation_id, idempotencyKey: input.idempotency_key,
    actorUserId: checked.actorId,
    conversation: { scope: { workspaceId: checked.workspaceId, datasetId: input.dataset_id, kind: 'bi_dataset' } },
  }, select: { ...requestSelect, inputHash: true, conversation: { select: { version: true } } } });
  if (existing) {
    if (existing.inputHash !== inputHash) throw conflict();
    const { inputHash: _hash, conversation, ...request } = existing;
    void _hash;
    return { conversation_id: input.conversation_id, conversation_version: conversation.version, replayed: true, request };
  }
  const config = getProjectLlmConfig(input.model);
  if (!config.agent.enabled || !process.env[config.credentialEnv]?.trim()) {
    throw new BiAgentProblem('BI_AGENT_MODEL_UNAVAILABLE', 503, '当前模型尚未配置或已停用；经营页面仍可正常使用。');
  }
  const pageScope = await (dependencies.resolvePage ?? resolveBiAgentPage)(checked,
    input.dataset_id, input.dataset_version, input.page_scope);
  return client.$transaction(async (tx) => {
    // Serialize first-message creation and subsequent versions, even before the
    // conversation exists. Only the bounded UUID enters a parameterized lock.
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.conversation_id}, 0))::text`);
    const current = await recheckBiAgentSession(checked.sessionId, checked.workspaceId, 'run', tx);
    if (current.actorId !== checked.actorId) throw notFound();
    const personal = current.workspaceId === `account:${current.actorId}`;
    const scopeId = randomUUID();
    await tx.$executeRaw(Prisma.sql`INSERT INTO agent_execution_scopes
      (id, kind, workspace_id, dataset_id, owner_user_id, shared_project_id)
      VALUES (${scopeId}, 'bi_dataset', ${current.workspaceId}, ${input.dataset_id},
        ${personal ? current.actorId : null}, ${personal ? null : current.workspaceId})
      ON CONFLICT (kind, workspace_id, dataset_id) DO NOTHING`);
    const scope = await tx.agentExecutionScope.findUniqueOrThrow({ where: {
      kind_workspaceId_datasetId: { kind: 'bi_dataset', workspaceId: current.workspaceId, datasetId: input.dataset_id },
    } });
    let conversation = await tx.biAgentConversation.findUnique({ where: { id: input.conversation_id } });
    if (conversation && (conversation.actorUserId !== current.actorId || conversation.executionScopeId !== scope.id)) throw notFound();
    if (!conversation) {
      if (input.expected_conversation_version !== 0) throw conflict();
      conversation = await tx.biAgentConversation.create({ data: { id: input.conversation_id,
        executionScopeId: scope.id, actorUserId: current.actorId, title: Array.from(input.instruction).slice(0, 80).join('') } });
    }
    const replay = await tx.biAgentRequest.findUnique({ where: {
      conversationId_idempotencyKey: { conversationId: conversation.id, idempotencyKey: input.idempotency_key },
    }, select: { ...requestSelect, inputHash: true } });
    if (replay) {
      if (replay.inputHash !== inputHash) throw conflict();
      const { inputHash: _hash, ...request } = replay; void _hash;
      return { conversation_id: conversation.id, conversation_version: conversation.version, replayed: true, request };
    }
    if (conversation.version !== input.expected_conversation_version) throw conflict();
    if (await tx.agentRun.findFirst({ where: { biRequest: { conversationId: conversation.id }, status: { in: ACTIVE } }, select: { id: true } })) {
      throw new BiAgentProblem('BI_AGENT_BUSY', 409, '上一条问题仍在处理中，请等待结果或先取消。');
    }
    const request = await tx.biAgentRequest.create({ data: {
      conversationId: conversation.id, executionScopeId: scope.id, actorUserId: current.actorId,
      sessionId: current.sessionId, idempotencyKey: input.idempotency_key, inputHash,
      instruction: input.instruction, pageScope, datasetVersion: input.dataset_version, model: input.model,
    } });
    const workspaceKey = `sha256:${createHash('sha256').update(`bi-runtime:${scope.id}`).digest('hex')}`;
    await tx.agentRun.create({ data: { id: randomUUID(), projectId: null, requestId: null,
      executionScopeId: scope.id, biRequestId: request.id, actorUserId: current.actorId,
      workspaceKey, status: 'pending', provider: config.provider, model: input.model,
      frameworkVersion: PI_AGENT_FRAMEWORK_VERSION, buildRevision: PI_AGENT_BUILD_REVISION,
      profileHash: digest({ profileId: config.profileId, model: config.model, provider: config.provider }),
      promptHash: digest({ instruction: input.instruction, pageScope }),
      // Queue provenance describes the acceptance contract. The worker must verify
      // this contract before claiming; it cannot silently swap in filesystem tools.
      toolHash: digest({ contract: 'bi-controlled-tools-v1' }), skillHash: digest([]),
      workspaceHash: digest({ workspaceId: current.workspaceId, datasetId: input.dataset_id,
        version: input.dataset_version, pageScope }),
    } });
    const updated = await tx.biAgentConversation.update({ where: { id: conversation.id }, data: { version: { increment: 1 } } });
    return { conversation_id: conversation.id, conversation_version: updated.version, replayed: false,
      request: await tx.biAgentRequest.findUniqueOrThrow({ where: { id: request.id }, select: requestSelect }) };
  }, { maxWait: 5000, timeout: 15_000 });
}

/** Private history is available after run capability is withdrawn, but only with
 * current data/membership read access. No session IDs or private engine state. */
export async function listBiAgentQuestions(authority: BiAgentAuthority, conversationId: string,
  page = 1, client: PrismaClient = prisma) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw conflict();
  const current = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'read', client);
  if (current.actorId !== authority.actorId) throw notFound();
  return client.$transaction(async (tx) => {
    const conversation = await tx.biAgentConversation.findFirst({ where: { id: conversationId,
      actorUserId: current.actorId, scope: { workspaceId: current.workspaceId, kind: 'bi_dataset' } },
    select: { id: true, title: true, version: true, scope: { select: { datasetId: true, workspaceId: true } } } });
    if (!conversation) throw notFound();
    const where = { conversationId, actorUserId: current.actorId };
    const total = await tx.biAgentRequest.count({ where });
    const rows = await tx.biAgentRequest.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * 20, take: 20, select: requestSelect });
    return { conversation, rows, total, page, page_size: 20 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function cancelBiAgentQuestion(authority: BiAgentAuthority, runId: string, client: PrismaClient = prisma) {
  const current = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'read', client);
  if (current.actorId !== authority.actorId) throw notFound();
  return client.$transaction(async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, actorUserId: current.actorId,
      biRequestId: { not: null }, scope: { workspaceId: current.workspaceId, kind: 'bi_dataset' } }, select: runSelect });
    if (!run) throw notFound();
    if (ACTIVE.includes(run.status)) {
      // Pending cancellation races the existing claimLease CAS. If a worker wins,
      // persist its cancellation flag without invalidating its heartbeat fence.
      await tx.agentRun.updateMany({ where: { id: run.id, status: 'pending', version: run.version }, data: {
        status: 'cancelled', cancelRequestedAt: new Date(), finishedAt: new Date(),
        errorCode: 'RUN_CANCELLED', version: { increment: 1 },
      } });
      await tx.agentRun.updateMany({ where: { id: run.id, status: { in: ACTIVE }, cancelRequestedAt: null },
        data: { cancelRequestedAt: new Date() } });
    }
    return tx.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: runSelect });
  });
}

/** A worker starts only requests with a real live session, not legacy NULL rows. */
export async function authorizeBiAgentRun(runId: string, client: PrismaClient = prisma) {
  const run = await client.agentRun.findUnique({ where: { id: runId }, include: {
    biRequest: { include: { conversation: { include: { scope: true } } } },
  } });
  const request = run?.biRequest;
  if (!run || !request?.sessionId || !ACTIVE.includes(run.status)) throw notFound();
  if (run.cancelRequestedAt) throw new BiAgentProblem('BI_AGENT_CANCELLED', 409, '此分析已请求取消。');
  const scope = request.conversation.scope;
  const authority = await recheckBiAgentSession(request.sessionId, scope.workspaceId, 'run', client);
  if (authority.actorId !== request.actorUserId || run.actorUserId !== authority.actorId
      || scope.kind !== 'bi_dataset' || !scope.datasetId) throw notFound();
  return { authority, run, request, datasetId: scope.datasetId, pageScope: biAgentPageScopeSchema.parse(request.pageScope) };
}
