import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { BI_AGENT_TOOL_DEFINITIONS, resultPage, dictionaryFilter } from './tool-manifest';
import type { readBiAgentLedger } from './ledger';
import type { PiAgentTool, PiAgentToolContext, PiAgentToolResult } from '@/lib/agent/types';
import type { readBiAgentMetricCatalog } from './ledger';
import { BiAgentProblem } from './contracts';
import { collectBiAgentMetricSource } from './metric-sources';
import { ledgerRowSchema, ledgerTableSchema } from '../overview-contracts';
import { BI_RESULT_READING_GUIDE, displayBiMetrics, displayBiRows, orderCountComparison } from './presentation';
import { collectBiAgentResult, inspectBiAgentResultPage, saveBiAgentAnswer, assertBiAgentResultFence, type BiAgentResultFence } from './results';

/** Product tools only. No generated source files, shell, arbitrary network,
 * identity selection, raw SQL or auto-confirmed mutations are registered. */
export type BiAgentToolDependencies = { client?: PrismaClient; read?: typeof readBiAgentLedger; catalog?: typeof readBiAgentMetricCatalog };
function paymentCostEvidence(metrics: Record<string, unknown>, quality: Record<string, unknown>) {
  const reasons = quality.payment_missing_reasons;
  if (!reasons || typeof reasons !== 'object' || !('missing_cost' in reasons) ||
      typeof reasons.missing_cost !== 'number' || reasons.missing_cost <= 0) return {};
  return { payment_cost_evidence: {
    affected_payment_lines: reasons.missing_cost,
    explanation: '这些原付款明细在付款时未找到适用的成本。以此说明缺项，不推测供应价格或成本为何没有登记。',
    ...(Object.hasOwn(metrics, 'contribution_profit') && { full_profit: metrics.contribution_profit }),
    ...(Object.hasOwn(metrics, 'accounted_contribution') && { supported_contribution: metrics.accounted_contribution }),
    ...(Object.hasOwn(metrics, 'coverage_ratio') && { paid_amount_coverage: metrics.coverage_ratio }),
  } };
}

/** Keep the citation and exact totals together at the start of the receipt.
 * The context manager may retain only this prefix on later model turns. */
function ledgerReceipt(result: { evidence_id: string; total: number; query: unknown; metadata: unknown }) {
  const meta = ledgerTableSchema.pick({ version: true, range: true, summary: true }).extend({ data_cutoff: z.string().nullable() }).partial().parse(result.metadata ?? {});
  const query = z.object({ dimension: z.string().optional() }).parse(result.query ?? {});
  return { evidence_id: result.evidence_id, dimension: query.dimension, total: result.total,
    version: meta.version, range: meta.range, data_cutoff: meta.data_cutoff,
    metrics: meta.summary?.metrics, missing_payments: meta.summary?.quality.payment_missing_reasons };
}

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
          const { metrics } = dictionaryFilter.parse(raw);
          const source = await collectBiAgentMetricSource(fence, context.signal, dependencies);
          if (!metrics) return { ok: true, data: source };
          const wanted = new Set<string>(metrics);
          return { ok: true, data: { ...source, metrics: source.metrics.filter(row => wanted.has(row.id)) } };
        }
        if (name === 'query_ledger') {
          const result = await collectBiAgentResult(fence, context.operationId, raw, context.signal, dependencies);
          const summary = ledgerTableSchema.shape.summary.parse((result.metadata as Record<string, unknown>).summary);
          const rows = z.array(ledgerRowSchema).parse(result.preview);
          const comparison = orderCountComparison(summary.metrics.order_count, result.total, rows);
          return { ok: true, data: { citation: ledgerReceipt(result), display_preview: displayBiRows(rows), ...paymentCostEvidence(summary.metrics, summary.quality), ...result, reading_guide: BI_RESULT_READING_GUIDE, display_summary: displayBiMetrics(summary.metrics),
            ...(comparison ? { order_count_comparison: comparison } : {}) } };
        }
        if (name === 'read_result_page') {
          const input = resultPage.parse(raw);
          const result = await inspectBiAgentResultPage(fence, input.evidence_id, input.page, dependencies.client);
          return { ok: true, data: { citation: ledgerReceipt(result), ...result, reading_guide: BI_RESULT_READING_GUIDE, display_rows: displayBiRows(z.array(ledgerRowSchema).parse(result.rows)) } };
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
