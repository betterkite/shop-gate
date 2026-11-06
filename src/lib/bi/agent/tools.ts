import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BI_AGENT_TOOL_DEFINITIONS, resultPage, empty } from './tool-manifest';
import type { readBiAgentLedger } from './ledger';
import type { PiAgentTool, PiAgentToolContext, PiAgentToolResult } from '@/lib/agent/types';
import { authorizeBiAgentRun } from './requests';
import { readBiAgentMetricCatalog } from './ledger';
import { BiAgentProblem } from './contracts';
import { BI_METRICS } from './result-contracts';
import { collectBiAgentResult, inspectBiAgentResultPage, saveBiAgentAnswer, assertBiAgentResultFence, type BiAgentResultFence } from './results';

/** Product tools only. No generated source files, shell, arbitrary network,
 * identity selection, raw SQL or auto-confirmed mutations are registered. */
export type BiAgentToolDependencies = { client?: PrismaClient; read?: typeof readBiAgentLedger; catalog?: typeof readBiAgentMetricCatalog };
export function createBiAgentTools(fence: BiAgentResultFence, dependencies: BiAgentToolDependencies = {}): PiAgentTool[] {
  return BI_AGENT_TOOL_DEFINITIONS.map(({ name, description, schema }) => ({
    name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    effect: 'read', idempotency: 'intrinsic', terminal: name === 'submit_answer',
    async execute(raw: unknown, context: PiAgentToolContext): Promise<PiAgentToolResult> {
      try {
        context.signal.throwIfAborted();
        if (context.runId !== fence.runId) throw new Error('Run binding changed.');
        await assertBiAgentResultFence(fence, dependencies.client);
        if (name === 'metric_dictionary') {
          empty.parse(raw);
          const authorized = await authorizeBiAgentRun(fence.runId, dependencies.client);
          const data = await (dependencies.catalog ?? readBiAgentMetricCatalog)(authorized.authority, context.signal);
          return { ok: true, data: { metrics: data.filter((metric) => (BI_METRICS as readonly string[]).includes(metric.id)) } };
        }
        if (name === 'query_ledger') {
          return { ok: true, data: await collectBiAgentResult(fence, context.operationId, raw, context.signal, dependencies) };
        }
        if (name === 'read_result_page') {
          const input = resultPage.parse(raw);
          return { ok: true, data: await inspectBiAgentResultPage(fence, input.evidence_id, input.page, dependencies.client) };
        }
        const content = await saveBiAgentAnswer(fence, raw, dependencies.client);
        // Public durable tool receipts contain IDs and bounded status only.
        return { ok: true, data: { accepted: true, kind: content.kind, evidence_ids: content.evidence_ids } };
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof z.ZodError) return { ok: false, error: {
          code: 'BI_AGENT_INPUT_INVALID', message: '参数不符合工具约定，请使用允许的指标、维度、日期和证据编号。' } };
        if (error instanceof BiAgentProblem) return { ok: false, error: { code: error.code, message: error.message } };
        return { ok: false, error: { code: 'BI_AGENT_QUERY_UNAVAILABLE',
          message: '当前取数或保存未完成，请检查数据版本、登录权限和服务状态；不能用猜测值替代结果。' } };
      }
    },
  }));
}
