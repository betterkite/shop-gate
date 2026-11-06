// Browser-safe display contracts. No SQL, JavaScript, HTML or provider history.
import { z } from 'zod';
import { ledgerRowSchema, ledgerTableSchema } from '../overview-contracts';
import { biAgentPageScopeSchema } from './contracts';

export const BI_AGENT_CHART_MAX_ROWS = 2000;
export const BI_METRICS = ['sales_amount', 'refund_amount', 'net_sales', 'order_count', 'average_order_value',
  'standard_quantity', 'product_cost', 'expense_amount', 'contribution_profit', 'accounted_contribution',
  'contribution_margin', 'refund_ratio', 'accounted_revenue', 'coverage_ratio'] as const;
export const biMetric = z.enum(BI_METRICS);
export const biDimension = z.enum(['overall', 'day', 'week', 'channel', 'store', 'product', 'sku', 'listing', 'order', 'line']);
const safeText = (length: number) => z.string().trim().min(1).max(length)
  .refine((value) => !value.includes('\0') && value.isWellFormed());
export const biAgentQuerySchema = z.object({
  dimension: biDimension.default('overall'), metrics: z.array(biMetric).min(1).max(BI_METRICS.length)
    .refine((values) => new Set(values).size === values.length).default([...BI_METRICS]),
  sort: z.union([biMetric, z.literal('key')]).default('net_sales'), descending: z.boolean().default(true),
  // An explicitly described comparison period; all selected entities stay bound.
  period: z.object({ start: z.string(), end: z.string(), reason: safeText(200) }).strict().optional(),
}).strict();
export function scopedBiAgentQuery(page: unknown, raw: unknown) {
  const { module: _module, ...scope } = biAgentPageScopeSchema.parse(page); void _module;
  const { period, ...selection } = biAgentQuerySchema.parse(raw);
  if (period) biAgentPageScopeSchema.parse({ ...scope, module: 'overview', start: period.start, end: period.end });
  return { ...scope, ...selection, ...(period ? { start: period.start, end: period.end } : {}) };
}
export const biAgentLedgerPageSchema = ledgerTableSchema.extend({
  page_size: z.literal(100), total: z.number().int().nonnegative().max(10_000_000),
  rows: z.array(ledgerRowSchema).max(100), algorithm_version: z.string().min(1),
  data_cutoff: z.string().nullable(), notes: z.array(z.string()).default([]),
});
export type BiAgentLedgerPage = z.infer<typeof biAgentLedgerPageSchema>;
export const biAgentAnswerSchema = z.object({
  kind: z.enum(['answer', 'clarification', 'data_unavailable']), text: safeText(12_000),
  evidence_ids: z.array(z.string().uuid()).max(16).refine((v) => new Set(v).size === v.length),
  views: z.array(z.object({ result_id: z.string().uuid(), kind: z.enum(['table', 'line', 'bar']),
    metric: biMetric }).strict()).max(6).default([]),
  follow_up: z.array(safeText(300)).max(3).default([]),
}).strict().refine((answer) => answer.kind !== 'answer' || answer.evidence_ids.length > 0)
  .refine((answer) => answer.views.every((v) => answer.evidence_ids.includes(v.result_id)))
  .refine((answer) => new TextEncoder().encode(JSON.stringify(answer)).byteLength <= 55_000);
export type BiAgentAnswerContent = z.infer<typeof biAgentAnswerSchema>;
