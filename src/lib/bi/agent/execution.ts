import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { PiAgentRunEngine } from '@/lib/agent/pi/run-engine';
import { PiAgentContextManager } from '@/lib/agent/context';
import { DeepSeekProvider } from '@/lib/agent/providers/deepseek';
import { OpenAICompatibleProvider } from '@/lib/agent/providers/openai-compatible';
import type { PiAgentMessage, PiAgentModelProvider } from '@/lib/agent/types';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { PiAgentDurableRunSession } from '@/lib/services/pi-agent-run-store';
import { createQuotaService } from '@/lib/quota/service';
import { getProjectLlmConfig } from '@/lib/config/llm';
import { biAgentTokenReservationKey, settleAgentRunUsage } from '@/lib/services/pi-agent-usage-settlement';
import { authorizeBiAgentRun } from './requests';
import { createBiAgentTools, type BiAgentToolDependencies } from './tools';
import { assertBiAgentResultFence } from './results';
import { BI_AGENT_SYSTEM_PROMPT, biAgentProvenance } from './provenance';
import { publishBiAgentAnswer } from './completion';
import { previousBiPeriod } from './period';

export const BI_AGENT_BUDGET = { turns: 8, output: 12_000, input: 96_000, perTurnOutput: 3_000,
  timeoutMs: 180_000, toolCalls: 24 } as const;

/** No history from another account/conversation and no private model reasoning.
 * Older display history remains in the database; the prompt explicitly marks its window. */
async function messagesFor(authorized: Awaited<ReturnType<typeof authorizeBiAgentRun>>, client: PrismaClient): Promise<PiAgentMessage[]> {
  const { request, authority } = authorized;
  const prior = await client.biAgentRequest.findMany({ where: { conversationId: request.conversationId,
    actorUserId: authority.actorId, id: { not: request.id }, createdAt: { lte: request.createdAt } },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 9,
  select: { instruction: true, pageScope: true, datasetVersion: true,
    runs: { where: { status: 'completed' }, select: { id: true }, take: 1 } } });
  const messages: PiAgentMessage[] = [{ role: 'system', content: BI_AGENT_SYSTEM_PROMPT },
    { role: 'system', content: `可信当前页面范围：${JSON.stringify({ dataset_id: authorized.datasetId,
      version: request.datasetVersion, ...authorized.pageScope, previous_equal_length_period: previousBiPeriod(authorized.pageScope) })}\n最多带入最近8轮历史；${prior.length > 8 ? '更早的对话未带入，不要假定其细节。' : '以下是已有对话。'}` }];
  for (const previous of prior.slice(0, 8).reverse()) {
    const answer = previous.runs[0] && await client.biAgentAnswer.findUnique({ where: { runId: previous.runs[0].id } });
    messages.push({ role: 'user', content: JSON.stringify({ question: previous.instruction,
      historical_version: previous.datasetVersion, historical_scope: previous.pageScope }) });
    if (answer) messages.push({ role: 'assistant', content: JSON.stringify(answer.content) });
  }
  messages.push({ role: 'user', content: request.instruction });
  return messages;
}

type ExecutionDependencies = BiAgentToolDependencies & {
  /** Internal test adapter only; never supplied by an HTTP request. */
  provider?: PiAgentModelProvider;
};

/** Called only by the independent leased worker, never an unawaited web task. */
export async function executeBiAgentRun(input: { runId: string; expectedVersion: number; leaseOwner: string;
  signal: AbortSignal; assertCapacity: () => void }, dependencies: ExecutionDependencies = {}) {
  const client = dependencies.client ?? prisma;
  const initial = await authorizeBiAgentRun(input.runId, client);
  const config = getProjectLlmConfig(initial.request.model);
  if (!config.agent.enabled || !process.env[config.credentialEnv]?.trim()) throw new Error('BI_AGENT_MODEL_UNAVAILABLE');
  const expected = biAgentProvenance(config, initial.request.instruction, initial.pageScope,
    initial.authority.workspaceId, initial.datasetId, initial.request.datasetVersion);
  if (Object.entries(expected).some(([key, value]) => initial.run[key as keyof typeof expected] !== value)) {
    throw new Error('BI_AGENT_RUNTIME_CHANGED');
  }
  input.signal.throwIfAborted(); input.assertCapacity();
  const abort = new AbortController(), signal = AbortSignal.any([input.signal, abort.signal]);
  const repository = new PrismaAgentRuntimeRepository(client);
  const session = await PiAgentDurableRunSession.claimPending({ repository, runId: input.runId,
    expectedVersion: input.expectedVersion, leaseOwner: input.leaseOwner,
    onFatal: () => abort.abort(new Error('BI_AGENT_LEASE_LOST')),
    onTerminalRun: async (run) => { await settleAgentRunUsage(client, run.id); } });
  const run = session.run, fence = { runId: run.id, leaseOwner: input.leaseOwner,
    fencingToken: run.fencingToken, workspaceFencingToken: run.workspaceFencingToken };
  const quota = createQuotaService(client);
  let reservationId: string | undefined, nextRenewal = 0;
  let timer: ReturnType<typeof setInterval> | undefined, checking: Promise<void> | undefined;
  const guard = async () => {
    signal.throwIfAborted(); input.assertCapacity();
    if (session.failure) throw session.failure;
    await assertBiAgentResultFence(fence, client);
    if (reservationId && Date.now() >= nextRenewal) {
      const renewed = await quota.renew({ reservationId, reservationTtlSeconds: 120 });
      nextRenewal = Date.now() + Math.max(100, Math.min(15_000, (renewed.expiresAt.getTime() - Date.now()) / 3));
    }
    signal.throwIfAborted();
  };
  try {
    const reserved = await quota.reserve({ actorUserId: initial.authority.actorId, metric: 'llm.total_tokens.monthly',
      quantity: BI_AGENT_BUDGET.input + BI_AGENT_BUDGET.output,
      idempotencyKey: biAgentTokenReservationKey(run.id), reservationTtlSeconds: 120 });
    if (!reserved.allowed) throw new Error('BI_AGENT_TOKEN_LIMIT');
    reservationId = reserved.reservation?.id;
    await guard();
    timer = setInterval(() => {
      if (checking || abort.signal.aborted) return;
      checking = guard().catch(() => abort.abort(new Error('BI_AGENT_EXECUTION_REVOKED')))
        .finally(() => { checking = undefined; });
    }, 1000);
    timer.unref?.();
    const base = dependencies.provider ?? (config.provider === 'deepseek'
      ? new DeepSeekProvider({ apiKey: process.env[config.credentialEnv]!, baseUrl: config.baseUrl, maxRetries: 0 })
      : new OpenAICompatibleProvider({ apiKey: process.env[config.credentialEnv]!, baseUrl: config.baseUrl, maxRetries: 0 }));
    const provider: PiAgentModelProvider = { name: base.name, async *complete(request) {
      await guard();
      yield* base.complete(request);
    } };
    const engine = new PiAgentRunEngine({ provider, model: config.model, tools: createBiAgentTools(fence, dependencies),
      contextManager: new PiAgentContextManager({ contextWindowTokens: 128_000,
        reservedOutputTokens: BI_AGENT_BUDGET.perTurnOutput, maxInputTokens: 24_000, contextCapsuleMaxUtf8Bytes: 2048 }),
      maxTurns: BI_AGENT_BUDGET.turns, maxTokens: BI_AGENT_BUDGET.output, maxTokensPerTurn: BI_AGENT_BUDGET.perTurnOutput,
      maxRunInputTokens: BI_AGENT_BUDGET.input, maxRunPreparedInputTokens: BI_AGENT_BUDGET.input,
      maxRunCacheMissInputTokens: BI_AGENT_BUDGET.input, maxTotalToolCalls: BI_AGENT_BUDGET.toolCalls,
      timeoutMs: BI_AGENT_BUDGET.timeoutMs, requireTerminalTool: true, requireWorkspaceWriteBeforeTerminal: false,
      preWriteReadOnlyTurnThreshold: BI_AGENT_BUDGET.turns, progressStallTurns: 3 });
    const messages = await messagesFor(initial, client);
    await guard();
    const result = await engine.run({ runId: run.id, messages, signal,
      temperature: 0.2, reasoning: { enabled: true, effort: 'medium' } },
    { durableSink: (event) => session.record(event) });
    if (timer) clearInterval(timer);
    await checking;
    const published = result.status === 'completed' ? await publishBiAgentAnswer(run.id, client) : { status: session.run.status };
    return { runId: run.id, status: published.status };
  } finally {
    if (timer) clearInterval(timer);
    await checking;
    try {
      if (['running', 'waiting', 'reconciling'].includes(session.run.status)) {
        await session.interrupt({ code: signal.aborted ? 'BI_AGENT_EXECUTION_REVOKED' : 'BI_AGENT_EXECUTION_INTERRUPTED' });
      }
    } finally {
      await session.close();
      // Also retries callbacks that failed after the terminal commit. The
      // maintenance worker settles after a crash or lost run fence.
      const current = await client.agentRun.findUnique({ where: { id: run.id } });
      if (current?.finishedAt) await settleAgentRunUsage(client, run.id);
    }
  }
}

/** Reject an unstarted incompatible request without inventing model usage. */
export async function failPendingBiAgentRun(runId: string, expectedVersion: number, code: string, client: PrismaClient = prisma) {
  if (!/^BI_AGENT_[A-Z_]{1,64}$/.test(code)) throw new Error('Invalid analysis failure code.');
  await client.$executeRaw(Prisma.sql`UPDATE agent_runs SET status='failed', finished_at=clock_timestamp(),
    error_code=${code}, error_message='分析尚未启动，请检查登录、模型配置和数据后重试。', version=version+1,
    updated_at=clock_timestamp() WHERE id=${runId} AND bi_request_id IS NOT NULL AND status='pending'
    AND version=${expectedVersion} AND fencing_token=0 AND started_at IS NULL`);
}
