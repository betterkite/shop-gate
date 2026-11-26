// Browser-safe display contracts. No SQL, JavaScript, HTML or provider history.
import { z } from 'zod';
import { ledgerRowSchema, ledgerTableSchema } from '../overview-contracts';
import { biAgentPageScopeSchema } from './contracts';
import { previousBiPeriod } from './period';

export const BI_AGENT_CHART_MAX_ROWS = 2000;
export const BI_METRICS = ['sales_amount', 'refund_amount', 'net_sales', 'order_count', 'average_order_value',
  'standard_quantity', 'product_cost', 'expense_amount', 'contribution_profit', 'accounted_contribution',
  'contribution_margin', 'refund_ratio', 'accounted_revenue', 'coverage_ratio', 'selling_channels', 'selling_stores', 'average_unit_price', 'weighted_unit_cost', 'costed_quantity',
  'platform_expense', 'packaging_expense', 'logistics_expense', 'advertising_expense', 'other_expense', 'known_unallocated_expenses', 'refund_event_count', 'refund_order_count', 'refund_cost_recovery'] as const;
export const biMetric = z.enum(BI_METRICS);
export const biDimension = z.enum(['overall', 'day', 'week', 'channel', 'store', 'product', 'sku', 'listing', 'order', 'line', 'refund_event', 'refund_reason', 'refund_type', 'current_report', 'cost_scenario']);
const safeText = (length: number) => z.string().trim().min(1).max(length)
  .refine((value) => !value.includes('\0') && value.isWellFormed());
export const biAgentQuerySchema = z.object({
  dimension: biDimension.default('overall'), metrics: z.array(biMetric).min(1).max(BI_METRICS.length)
    .refine((values) => new Set(values).size === values.length).default([...BI_METRICS]),
  sort: z.union([biMetric, z.literal('key')]).default('net_sales'), descending: z.boolean().default(true),
  hypothetical_unit_cost_cny: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/).optional(),
  comparison_refund_basis: z.enum(['payment', 'occurred']).optional(),
  // An explicitly described comparison period; all selected entities stay bound.
  period: z.union([z.literal('previous'), z.object({ start: z.string(), end: z.string(), reason: safeText(200) }).strict()]).optional(),
}).strict();
export function scopedBiAgentQuery(page: unknown, raw: unknown) {
  const { module, report, ...scope } = biAgentPageScopeSchema.parse(page);
  const { period: requested, comparison_refund_basis: basis, ...selection } = biAgentQuerySchema.parse(raw);
  if (selection.dimension === 'cost_scenario' || selection.hypothetical_unit_cost_cny !== undefined) {
    if (module !== 'costs' || scope.sku_ids.length !== 1 || selection.dimension !== 'cost_scenario' ||
        selection.hypothetical_unit_cost_cny === undefined) throw new Error('成本试算需要在成本页选择一个规格并输入假设单位成本。');
  }
  if (selection.dimension === 'current_report' && (module !== 'reports' || !report)) throw new Error('请先打开需要核对的经营报表。');
  if (report?.search && selection.dimension !== 'current_report') throw new Error('请用 current_report 查询当前搜索结果。');
  if (basis && module !== 'refunds') throw new Error('请在退款与售后页面比较两种日期口径。');
  const period = requested === 'previous' ? previousBiPeriod(scope) : requested;
  if (requested === 'previous' && !period) throw new Error('当前页面没有可比较的完整日期范围。');
  if (period) biAgentPageScopeSchema.parse({ ...scope, module: 'overview', start: period.start, end: period.end });
  return { ...scope, ...selection, ...(selection.dimension === "current_report" && report && {report}), ...(basis && { refund_basis: basis }), ...(period ? { start: period.start, end: period.end } : {}) };
}
export const biAgentLedgerPageSchema = ledgerTableSchema.extend({
  page_size: z.literal(100), total: z.number().int().nonnegative().max(10_000_000),
  rows: z.array(ledgerRowSchema).max(100), algorithm_version: z.string().min(1),
  data_cutoff: z.string().nullable(), notes: z.array(z.string()).default([]),
});
export type BiAgentLedgerPage = z.infer<typeof biAgentLedgerPageSchema>;
const amount = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const draftEntity = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/).refine((id) => id !== '__unattributed__');
const evidenceRow = z.object({ result_id: z.string().uuid(), position: z.number().int().positive().max(10_000_000) }).strict();
export const mappingDraftSchema = z.object({
  listing_id: draftEntity, listing_evidence: evidenceRow.optional(),
  sku_search: safeText(200).optional(),
  multiplier: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/).refine((value) => /[1-9]/.test(value)).optional(),
  // A local input for the Beijing business calendar. The editor attaches the zone on preview.
  effective_local: z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/).refine((value) => {
    const d = new Date(value + ':00Z');
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 16) === value;
  }).optional(),
}).strict();
export type MappingDraft = z.infer<typeof mappingDraftSchema>;
export const targetDraftSchema = z.object({
  store_id: draftEntity,
  month: z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/),
  sales_target: z.string().regex(amount).refine((n) => !n.startsWith('-')).optional(),
  profit_target: z.string().regex(amount).nullable().optional(),
  clear_profit_target: z.literal(true).optional(),
  store_evidence: evidenceRow.optional(),
}).strict().refine((value) => value.sales_target !== undefined || value.profit_target !== undefined || value.clear_profit_target)
  .refine((value) => !value.clear_profit_target || value.profit_target == null);
export type TargetDraft = z.infer<typeof targetDraftSchema>;
/** A historical null is ambiguous. Only an operator can clear the existing value in the editor. */
export function targetDraftInputs(current: { sales_target: string | null; profit_target: string | null } | undefined, draft?: TargetDraft) {
  return {
    sales: draft?.sales_target ?? current?.sales_target ?? '',
    profit: draft?.profit_target ?? current?.profit_target ?? '',
  };
}
const costDraftSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('recalculate'), only_missing: z.boolean() }).strict(),
  z.object({ action: z.literal('adjust'), method: z.enum(['fixed','amount','percent']),
    value: z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/), currency: z.string().regex(/^[A-Z]{3}$/),
    level: z.enum(['base','store','channel']).optional(), effective_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  }).strict(),
]);
export type CostDraft = z.infer<typeof costDraftSchema>;
export const biAgentAnswerSchema = z.object({
  kind: z.enum(['answer', 'definition', 'clarification', 'data_unavailable', 'target_proposal', 'mapping_proposal', 'cost_proposal']),
  cost_draft: costDraftSchema.optional(), target_draft: targetDraftSchema.optional(), mapping_draft: mappingDraftSchema.optional(), text: safeText(12_000),
  evidence_ids: z.array(z.string().uuid()).max(16).refine((v) => new Set(v).size === v.length),
  definition_source_id: z.string().uuid().optional(),
  definition_ids: z.array(biMetric).max(BI_METRICS.length).default([])
    .refine((ids) => new Set(ids).size === ids.length),
  views: z.array(z.object({ result_id: z.string().uuid(), kind: z.enum(['table', 'line', 'bar']),
    metric: biMetric }).strict()).max(6).default([]),
  follow_up: z.array(safeText(300)).max(3).default([]),
}).strict().refine((answer) => (answer.kind === 'target_proposal') === Boolean(answer.target_draft))
  .refine((answer) => (answer.kind === 'cost_proposal') === Boolean(answer.cost_draft))
  .refine((answer) => (answer.kind === 'mapping_proposal') === Boolean(answer.mapping_draft))
  .refine((answer) => !answer.mapping_draft?.listing_evidence || answer.evidence_ids.includes(answer.mapping_draft.listing_evidence.result_id))
  .refine((answer) => !answer.target_draft?.store_evidence || answer.evidence_ids.includes(answer.target_draft.store_evidence.result_id))
  .refine((answer) => answer.kind !== 'answer' || answer.evidence_ids.length > 0)
  .refine((answer) => Boolean(answer.definition_source_id) === (answer.definition_ids.length > 0))
  .refine((answer) => answer.kind !== 'definition' || (answer.definition_ids.length > 0
    && answer.evidence_ids.length === 0 && answer.views.length === 0))
  .refine((answer) => answer.views.every((v) => answer.evidence_ids.includes(v.result_id)))
  .refine((answer) => new TextEncoder().encode(JSON.stringify(answer)).byteLength <= 55_000);
export type BiAgentAnswerContent = z.infer<typeof biAgentAnswerSchema>;
