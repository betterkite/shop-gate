import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthorizationError } from '@/lib/auth/authorization';
import { PI_AGENT_MODEL_DEFINITIONS } from '@/lib/constants/models';
import { getProjectLlmConfig } from '@/lib/config/llm';
import { QuotaError, QuotaExceededError } from '@/lib/quota/service';
import { hasLivePiAgentWorker } from '@/lib/services/pi-agent-worker-registry';
import { biFailure, input as boundedBiInput } from '../http';
import { authenticateBiAgent } from './authorization';
import { BiAgentProblem, biAgentIdentifier, biAgentSubmissionSchema } from './contracts';
import { cancelBiAgentQuestion, listBiAgentConversations, listBiAgentQuestions, submitBiAgentQuestion } from './requests';
import { readBiAgentAnswer, readBiAgentResultPage } from './results';

const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
const workspace = { workspace_id: biAgentIdentifier.optional() };
const paging = z.string().regex(/^[1-9]\d{0,6}$/).transform(Number).refine((v) => v <= 1_000_000).default(1);
const queries = z.discriminatedUnion('action', [
  z.object({ action: z.literal('availability'), ...workspace }).strict(),
  z.object({ action: z.literal('conversations'), ...workspace, dataset_id: biAgentIdentifier, page: paging }).strict(),
  z.object({ action: z.literal('questions'), ...workspace, conversation_id: z.string().uuid(), page: paging }).strict(),
  z.object({ action: z.literal('answer'), ...workspace, run_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('result'), ...workspace, run_id: z.string().uuid(), result_id: z.string().uuid(), page: paging }).strict(),
]);
const mutations = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit'), question: biAgentSubmissionSchema }).strict(),
  z.object({ action: z.literal('cancel'), ...workspace, run_id: z.string().uuid() }).strict(),
]);
const json = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status, headers });

function failure(error: unknown) {
  let code: string, message: string, status: number;
  if (error instanceof BiAgentProblem) { code = error.code; message = error.message; status = error.status; }
  else if (error instanceof z.ZodError) { code = 'BI_AGENT_INPUT_INVALID'; message = '问题或筛选参数无效，请检查后重试。'; status = 422; }
  else if (error instanceof AuthorizationError) { code = 'BI_AGENT_AUTH_REVOKED'; message = '请重新登录，并确认你可以访问当前工作空间。'; status = error.status; }
  else if (error instanceof QuotaError) {
    code = error.code; status = error.status;
    message = error instanceof QuotaExceededError && error.decision.policy.metric === 'agent.pending'
      ? '等待处理的问题已达到上限，请等待完成或取消不再需要的分析。'
      : error instanceof QuotaExceededError ? '今天可提交的分析次数已用完，请等待额度恢复或联系管理员。'
        : '本次用量登记未完成，请使用原问题重试。';
  } else return biFailure(error);
  const requestId = randomUUID();
  return NextResponse.json({ success: false, error: code, message, request_id: requestId },
    { status, headers: { ...headers, 'X-Request-ID': requestId } });
}

export async function getBiAgent(request: NextRequest) {
  try {
    const values: Record<string, string> = {};
    for (const [key, value] of request.nextUrl.searchParams) {
      if (Object.hasOwn(values, key)) throw new BiAgentProblem('BI_AGENT_INPUT_INVALID', 422, '链接中有重复参数，请重新打开。');
      values[key] = value;
    }
    const q = queries.parse(values);
    const auth = await authenticateBiAgent(request.headers, q.workspace_id);
    switch (q.action) {
      case 'availability': {
        let canRun = true;
        try { await authenticateBiAgent(request.headers, auth.workspaceId, 'run'); }
        catch (error) { if (!(error instanceof AuthorizationError)) throw error; canRun = false; }
        const models = PI_AGENT_MODEL_DEFINITIONS.filter(({ id }) => {
          const config = getProjectLlmConfig(id);
          return config.agent.enabled && Boolean(process.env[config.credentialEnv]?.trim());
        }).map(({ id, name }) => ({ id, name }));
        return json({ workspace_id: auth.workspaceId, can_run: canRun, worker_available: await hasLivePiAgentWorker('bi_analysis'), models });
      }
      case 'conversations': return json(await listBiAgentConversations(auth, q.dataset_id, q.page));
      case 'questions': return json(await listBiAgentQuestions(auth, q.conversation_id, q.page));
      case 'answer': return json(await readBiAgentAnswer(auth, q.run_id));
      case 'result': return json(await readBiAgentResultPage(auth, q.run_id, q.result_id, q.page));
    }
  } catch (error) { return failure(error); }
}

export async function postBiAgent(request: NextRequest) {
  try {
    const body = mutations.parse(await boundedBiInput(request, 64 * 1024));
    if (body.action === 'cancel') {
      const auth = await authenticateBiAgent(request.headers, body.workspace_id, 'read');
      return json(await cancelBiAgentQuestion(auth, body.run_id));
    }
    const auth = await authenticateBiAgent(request.headers, body.question.workspace_id, 'run');
    const accepted = await submitBiAgentQuestion(auth, body.question, { assertAvailable: async () => {
      if (!await hasLivePiAgentWorker('bi_analysis')) throw new BiAgentProblem('BI_AGENT_MODEL_UNAVAILABLE', 503,
        '经营助手的处理服务暂未启动，请稍后重试；已有分析和经营页面仍可查看。');
    } });
    return json(accepted, accepted.replayed ? 200 : 202);
  } catch (error) { return failure(error); }
}
