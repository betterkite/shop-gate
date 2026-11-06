import { z } from 'zod';
import type { PiAgentTool, PiAgentToolContext, PiAgentToolResult } from '@/lib/agent/types';
import { authorizeBiAgentRun } from './requests';
import { readBiAgentMetricCatalog } from './ledger';
import { BiAgentProblem } from './contracts';
import { biAgentAnswerSchema, biAgentQuerySchema, BI_METRICS } from './result-contracts';
import { collectBiAgentResult, inspectBiAgentResultPage, saveBiAgentAnswer, assertBiAgentResultFence, type BiAgentResultFence } from './results';

const resultPage = z.object({ evidence_id: z.string().uuid(), page: z.number().int().min(1).max(1_000_000).default(1) }).strict();
const empty = z.object({}).strict();

/** Product tools only. No generated source files, shell, arbitrary network,
 * identity selection, raw SQL or auto-confirmed mutations are registered. */
export function createBiAgentTools(fence: BiAgentResultFence): PiAgentTool[] {
  const definitions = [
    { name: 'metric_dictionary', schema: empty,
      description: '读取当前账本的指标中文名称、公式、单位和缺失处理；以它说明口径，不自行发明利润公式。' },
    { name: 'query_ledger', schema: biAgentQuerySchema,
      description: '分析当前页面的固定数据集/版本/对象范围。返回全范围合计、完整结果证据编号及前20行预览；全表已保存。比较前期可明确提供period和reason，其他页面筛选保持。' },
    { name: 'read_result_page', schema: resultPage,
      description: '按每页20行读取本次分析已保存的完整查询结果。预览不是全量；超过20个对象可继续查看其他页。' },
    { name: 'submit_answer', schema: biAgentAnswerSchema,
      description: '提交面向用户的中文回答。事实必须引用本轮实际返回的evidence_ids。表格/图表只能引用这些证据和已查询指标。缺数据或必要歧义可明确说明；不可把缺失值当0，不改写经营页面。' },
  ];
  return definitions.map(({ name, description, schema }) => ({
    name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    effect: 'read', idempotency: 'intrinsic', terminal: name === 'submit_answer',
    async execute(raw: unknown, context: PiAgentToolContext): Promise<PiAgentToolResult> {
      try {
        context.signal.throwIfAborted();
        if (context.runId !== fence.runId) throw new Error('Run binding changed.');
        await assertBiAgentResultFence(fence);
        if (name === 'metric_dictionary') {
          empty.parse(raw);
          const authorized = await authorizeBiAgentRun(fence.runId);
          const data = await readBiAgentMetricCatalog(authorized.authority, context.signal);
          return { ok: true, data: { metrics: data.filter((metric) => (BI_METRICS as readonly string[]).includes(metric.id)) } };
        }
        if (name === 'query_ledger') {
          return { ok: true, data: await collectBiAgentResult(fence, context.operationId, raw, context.signal) };
        }
        if (name === 'read_result_page') {
          const input = resultPage.parse(raw);
          return { ok: true, data: await inspectBiAgentResultPage(fence, input.evidence_id, input.page) };
        }
        const content = await saveBiAgentAnswer(fence, raw);
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
