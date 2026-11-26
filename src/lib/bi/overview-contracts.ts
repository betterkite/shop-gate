// Browser-safe presentation and URL scope. Accounting remains in the ledger.
import { z } from 'zod';
import { PRODUCT_CONDITIONS, RANK_METRICS, type ProductCondition, type BusinessSection, type RankMetric } from './sections';
import { selectionSchema, type EvidenceSelection } from './agent/selection-contracts';
import { readAssistantViews, type AssistantViewState } from './agent/view-location';

import { reportTypes, type ReportType } from './report-config';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const version = z.number().int().positive().safe();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const metricValue = z.union([decimal, z.number().int().safe(), z.null()]);
const metrics = z.record(z.string(), metricValue);
const quality = z.record(z.string(), z.unknown());
const summary = z.object({ metrics, quality });
const range = z.object({ start: z.string().nullable(), end: z.string().nullable(), refund_basis: z.enum(['payment', 'occurred']) });
const page = { total: z.number().int().nonnegative(), page: z.number().int().positive(), page_size: z.literal(20) };
export const REFERENCE_LABELS = { channel: '销售平台', store: '店铺', product: '商品', sku: '标准规格', listing: '平台商品', category: '类目' } as const;
export type ReferenceKind = keyof typeof REFERENCE_LABELS;
const referenceKind = z.enum(['channel', 'store', 'product', 'sku', 'listing', 'category']);
export const referenceRowSchema = z.object({ key: z.string().max(200), name: z.string(),
  channel_id: identifier.optional(), channel_name: z.string().optional(), store_id: identifier.optional(), store_name: z.string().optional(),
  product_id: identifier.optional(), product_name: z.string().optional(), sku_id: identifier.optional(), listing_id: identifier.optional(),
  category: z.string().max(200).optional(), unit: z.string().optional(), platform_sku_id: z.string().optional() });
export type ReferenceRow = z.infer<typeof referenceRowSchema>;
export const referenceDirectorySchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, kind: referenceKind, ...page, rows: z.array(referenceRowSchema) });
export type ReferenceDirectory = z.infer<typeof referenceDirectorySchema>;
const expenseBreakdown = z.record(z.string(), z.object({ amount: decimal.nullable(), known_amount: decimal }));
export const ledgerRowSchema = z.object({ expense_breakdown: expenseBreakdown.optional(), key: z.string(), name: z.string(), metrics, quality,
  shares: z.record(z.string(), decimal.nullable()).optional() });
export type LedgerRow = z.infer<typeof ledgerRowSchema>;
export const ledgerTableSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, range, summary, rows: z.array(ledgerRowSchema), ...page });
export type LedgerTable = z.infer<typeof ledgerTableSchema>;
export const targetRowSchema = z.object({ store_id: identifier, store_name: z.string(), channel_id: identifier,
  month: z.string(), sales_target: decimal.nullable(), profit_target: decimal.nullable(),
  net_sales: decimal.nullable(), contribution_profit: decimal.nullable(), accounted_contribution: decimal.nullable(),
  completion_ratio: decimal.nullable(), profit_completion_ratio: decimal.nullable(),
  state: z.enum(['not_set', 'recorded']), actual_state: z.enum(['recorded', 'no_records']) });
export type TargetRow = z.infer<typeof targetRowSchema>;
const comparison = z.object({ current: metricValue, previous: metricValue, difference: decimal.nullable(),
  growth_ratio: decimal.nullable(), state: z.enum(['comparable', 'zero_base', 'negative_base', 'missing', 'history_insufficient']) });
export const overviewSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, algorithm_version: z.string(), data_cutoff: z.string().nullable(),
  recorded_start: z.string().nullable(), state: z.enum(['ready', 'empty']), range, summary,
  scope_names: z.array(z.object({ kind: referenceKind, key: z.string(), name: z.string().nullable() })).optional(),
  previous: z.object({ range, summary, history_sufficient: z.boolean() }).nullable(),
  comparison: z.record(z.string(), comparison),
  trend: z.object({ interval: z.enum(['day', 'week']), rows: z.array(z.object({ key: z.string(),
    start: z.string(), end: z.string(), state: z.enum(['recorded', 'no_records']),
    metrics: metrics.nullable(), quality: quality.nullable() })), note: z.string().optional() }),
  profit_statement: z.object({
    profit: decimal.nullable(), accounted: decimal, previous_profit: decimal.nullable(), change: decimal.nullable(), unallocated: decimal,
    rows: z.array(z.object({ key: z.enum(['sales_amount', 'refund_amount', 'product_cost', 'platform', 'packaging', 'logistics', 'advertising', 'other']),
      amount: decimal.nullable(), known_amount: decimal, previous: decimal.nullable(), change: decimal.nullable(), fee_share: decimal.nullable() })),
  }).optional(),
  channel_trends: z.object({
    period_page: version, period_total: z.number().int().nonnegative(), channel_page: version, channel_total: z.number().int().nonnegative(),
    periods: z.array(z.object({ key: z.string(), start: z.string(), end: z.string() })).max(20),
    channels: z.array(z.object({ key: z.string(), name: z.string(), points: z.array(metrics.nullable()).max(20) })).max(20),
  }).refine((value) => value.channels.every((channel) => channel.points.length === value.periods.length)).optional(),
  channels: z.object({ ...page, rows: z.array(ledgerRowSchema),
    share_states: z.record(z.string(), z.string()).optional() }),
  attention: z.object({ ...page, rows: z.array(z.object({ id: z.string(), title: z.string(),
    description: z.string(), rule: z.string(), severity: z.string(), evidence: z.record(z.string(), z.unknown()) })) }),
  targets: z.object({ ...page, rows: z.array(targetRowSchema), month: z.string(),
    configured_count: z.number().int().nonnegative(), sales_target_total: decimal.nullable(),
    actual_summary: summary, range: z.object({ start: z.string(), end: z.string() }), scope_note: z.string() }).nullable(),
  notes: z.array(z.string()).optional() });
export type Overview = z.infer<typeof overviewSchema>;
const targetAmounts = z.object({ sales_target: decimal, profit_target: decimal.nullable() });
export const targetPreviewSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  preview_id: identifier, expires_at: z.string().datetime({ offset: true }), impact: z.object({
    store_id: identifier, store_name: z.string(), channel_id: identifier, month: z.string(),
    previous: targetAmounts.nullable(), proposed: targetAmounts, changed: z.boolean(),
    version_before: version, expected_version_after: version, facts_unchanged: z.literal(true), notice: z.string() }) });
export type TargetPreview = z.infer<typeof targetPreviewSchema>;
export const targetCommitSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, changed: z.boolean(), data: z.object({
    target: targetAmounts.extend({ store_id: identifier, month: z.string() }),
    previous: targetAmounts.nullable(), facts_unchanged: z.literal(true) }) });

export const KPI_LABELS = {
  net_sales: { name: '净销售额', unit: '元', description: '付款成交金额减去所选日期口径下的已完成退款。' },
  accounted_contribution: { name: '已核算经营贡献', unit: '元', description: '已核算的收入减退款、商品成本和已知费用；不包含未接入的房租、人员等支出。' },
  order_count: { name: '付款订单数', unit: '笔', description: '已付款的订单数量，同一订单多件商品只计一笔。' },
  average_order_value: { name: '付款客单价', unit: '元/笔', description: '付款成交金额除以付款订单数。' },
  contribution_margin: { name: '经营贡献利润率', unit: '%', description: '完整经营贡献利润占净销售额的比例；核算不完整或净销售额不为正时不计算。' },
  refund_ratio: { name: '退款金额占比', unit: '%', description: '按原付款日期统计的已完成退款占付款成交金额的比例；退款发生日口径不提供此比例。' },
} as const;
export const COMPARISON_LABELS = { comparable: '与前期相比', zero_base: '前期为零，不计算增长率',
  negative_base: '前期为负数，不计算增长率', missing: '有金额待核算，暂不比较', history_insufficient: '前期记录不足，暂不比较' } as const;
export const DIMENSION_LABELS = { line: '订单明细', order: '订单', channel: '销售平台', store: '店铺',
  product: '商品', sku: '标准规格', listing: '平台商品', day: '按日汇总', week: '按周汇总' } as const;
export type SourceDimension = keyof typeof DIMENSION_LABELS;
export const QUALITY_LABELS = { unknown_revenue_lines: '缺少付款金额依据的订单明细', unknown_refund_lines: '缺少退款金额依据的订单明细',
  unknown_cost_lines: '缺少商品成本依据的订单明细', unknown_expenses: '尚未核算完整的费用',
  unknown_attribution_expenses: '尚未明确归属的费用', unknown_quantity_lines: '尚未明确标准数量的订单明细' } as const;
export type QualityKey = keyof typeof QUALITY_LABELS;
export const qualityKey = z.enum(['unknown_revenue_lines', 'unknown_refund_lines', 'unknown_cost_lines',
  'unknown_expenses', 'unknown_attribution_expenses', 'unknown_quantity_lines']);
export const POSTING_KINDS = { sale: '付款明细', refund: '退款明细', expense: '费用明细' } as const;
export type PostingKind = keyof typeof POSTING_KINDS;
const posting = z.object({
    key: z.string(), kind: z.enum(['sale', 'refund', 'expense']), source_id: identifier, date: z.string(),
    order_id: identifier.nullable(), line_id: identifier.nullable(), refund_id: identifier.nullable(), expense_id: identifier.nullable(),
    store_name: z.string().nullable(), listing_name: z.string().nullable(), paid_at: z.string().nullable(), occurred_at: z.string().nullable(),
    currency: z.string(), original_amount: decimal, amount_cny: decimal.nullable(), cost_cny: decimal.nullable(),
    source_amount_cny: decimal.nullable(),
});
const refundGroup = z.object({ total: z.number().int().nonnegative(), rows: z.array(z.object({
  key: z.string(), name: z.string(), count: z.number().int().positive(), amount: decimal.nullable(), known: decimal,
})) });
export const sourcePageSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, kind: z.enum(['sale', 'refund', 'expense']), range, ...page,
  refund_analysis: z.object({ totals: metrics, refund_reason: refundGroup, refund_type: refundGroup }).optional(),
  rows: z.array(posting.extend({ reason: z.string().nullish(), returned_quantity: decimal.nullish(),
    recoverable_quantity: decimal.nullish(), cancelled_quantity: decimal.nullish(), platform_order_id: z.string().nullable(), line_paid_amount: decimal.nullable(),
    expense_type: z.string().nullable(), refund_type: z.string().nullable(), allocation_method: z.string().nullable(),
    payment_missing: z.array(z.enum(['missing_mapping', 'missing_cost', 'missing_fx'])).nullish(),
    accounting_status: z.string().nullable() })) });
export type SourcePage = z.infer<typeof sourcePageSchema>;
export const qualityEvidenceSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, quality_key: qualityKey, range, data_cutoff: z.string().nullable(),
  scope_total: z.number().int().nonnegative(), ...page,
  rows: z.array(z.object({ key: identifier, kind: z.enum(['line', 'expense']), name: z.string(),
    store_name: z.string().nullable(), order_id: identifier.nullable(), date: z.string(),
    event_count: z.number().int().positive(), reasons: z.array(z.string()) })),
  events: z.object({ ...page, record_key: identifier.nullable(), rows: z.array(z.object({
    ...posting.shape, reason: z.string(),
  })) }) });
export type QualityEvidence = z.infer<typeof qualityEvidenceSchema>;

const mappingRow = z.object({
  key: identifier, name: z.string(), store_id: identifier, store_name: z.string(), channel_name: z.string(),
  platform_sku_id: z.string(), platform_product_id: z.string(), listing_unit: z.string(),
  mapping_status: z.enum(['mapped', 'missing']), mapping_id: identifier.nullable(),
  sku_id: identifier.nullable(), sku_name: z.string().nullable(), product_name: z.string().nullable(),
  multiplier: decimal.nullable(), unit: z.string().nullable(), valid_from: z.string().nullable(), valid_to: z.string().nullable(),
});
const costVersion = z.object({ cost_id: identifier, level: z.enum(['base', 'channel', 'store']), unit_cost: decimal,
  currency: z.string().regex(/^[A-Z]{3}$/), source: z.string(), valid_from: z.string(), valid_to: z.string().nullable(), superseded_version: version.nullable().optional(), created_version: version });
const masterCost = costVersion.extend({ channel_id: identifier.nullable(), store_id: identifier.nullable() });
const costResponse = z.object({ workspace_id: identifier, dataset_id: identifier, version, accounting_revision: version,
  as_of: z.string(), range, counts: z.object({ catalog: z.number(), with_cost: z.number(), missing: z.number(), rising: z.number(), negative: z.number() }),
  sales_coverage: decimal.nullable(), ...page });
export const costDirectorySchema = costResponse.extend({ history_sku: z.null(), rows: z.array(z.object({
  key: identifier, name: z.string(), product_id: identifier, product_name: z.string(), category: z.string(), unit: z.string(),
  applied: masterCost.nullable(), base: masterCost.nullable(), previous: masterCost.nullable(), change_rate: decimal.nullable(),
  has_records: z.boolean(), incomplete_paid_lines: z.number().int(), metrics,
})) });
export const skuCostHistorySchema = costResponse.extend({ history_sku: identifier, rows: z.array(masterCost) });
export type CostDirectoryData = z.infer<typeof costDirectorySchema>;
export type SkuCostHistory = z.infer<typeof skuCostHistorySchema>;
export const listingCostsSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version, accounting_revision: version,
  kind: z.literal('listing_cost'), as_of: z.string(), listing_id: identifier, listing: mappingRow.nullable(), applied: costVersion.nullable(),
  rows: z.array(costVersion), ...page });
export type ListingCosts = z.infer<typeof listingCostsSchema>;

export const mappingDirectorySchema = z.object({
  workspace_id: identifier, dataset_id: identifier, version, accounting_revision: version,
  kind: z.literal('mapping'), as_of: z.string(), ...page,
  rows: z.array(mappingRow),
});
export type MappingDirectory = z.infer<typeof mappingDirectorySchema>;
const mappingChange = z.object({ listing_id: identifier, sku_id: identifier, multiplier: decimal, effective_at: z.string() });
const mappingImpact = z.object({ name: z.string(), platform_sku_id: z.string(), store_name: z.string(),
  sku_name: z.string(), unit: z.string(), standard_unit: z.string(), historical_paid_lines: z.number().int().nonnegative(),
  changed: z.boolean(), proposed: mappingChange, valid_to: z.string().nullable(),
  previous: z.object({ mapping_id: identifier, sku_id: identifier, sku_name: z.string(), unit: z.string(),
    multiplier: decimal, valid_from: z.string(), valid_to: z.string().nullable() }).nullable() });
export const mappingPreviewSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  preview_id: z.string().uuid(), expires_at: z.string(), impact: mappingImpact });
export type MappingPreview = z.infer<typeof mappingPreviewSchema>;
export const mappingCommitSchema = z.object({ workspace_id: identifier, dataset_id: identifier, version,
  accounting_revision: version, changed: z.boolean(), data: mappingImpact });
export type OverviewLocation = { workspaceId?: string; datasetId?: string; datasetPage: number;
  start?: string; end?: string; channelId?: string; storeId?: string; productId?: string; skuId?: string; listingId?: string; category?: string;
  interval: 'day' | 'week'; refundBasis: 'payment' | 'occurred'; channelMetric: 'net_sales' | 'accounted_contribution';
  channelPage: number; trendPage: number; targetPage: number; targetMonth?: string; editStoreId?: string;
  filterKind?: ReferenceKind; filterPage: number; filterSearch: string; filterSort: 'name' | 'key'; filterDescending: boolean;
  qualityKey?: QualityKey; evidencePage: number; evidenceSearch: string; evidenceSort: 'key' | 'name' | 'date'; evidenceDescending: boolean;
  evidenceRecord?: string; evidenceEventPage: number;
  conversationId?: string; conversationPage?: number; questionPage?: number; assistantViews?: AssistantViewState[]; selection?: EvidenceSelection;
  channelTrendMetric?: 'net_sales' | 'contribution_profit' | 'contribution_margin' | 'refund_ratio';
  groupCondition?: ProductCondition; conditionGrain?: 'product' | 'sku' | 'listing'; conditionStart?: string; conditionEnd?: string;
  costAsOf?: string; catalogPage?: number; catalogSearch?: string; catalogDescending?: boolean;
  catalogSort?: 'key' | 'name' | 'unit_cost' | 'sales_amount' | 'change_rate' | 'contribution_profit';
  reportType?: ReportType; reportSort?: string; reportSearch?: string; reportColumns?: string;
  reportDescending?: boolean; reportPage?: number; viewsPage?: number; savedTopic?: string;
  catalogCondition?: 'all' | 'missing' | 'rising' | 'negative' | 'low_margin'; historySku?: string; historyPage?: number; costOperation?: string; operationPage?: number;
  refundReasonId?: string; refundType?: 'refund_only' | 'return' | 'unshipped_cancel'; refundSearch?: string;
  refundPage?: number; reasonPage?: number; refundSort?: 'date' | 'amount' | 'cost' | 'order_id'; refundDescending?: boolean;
  rankPage?: number; rankSearch?: string; rankSort?: RankMetric; rankDescending?: boolean; rankGrain?: 'product' | 'sku' | 'listing'; profitView?: 'current' | 'change'; profitGroup?: 'channel' | 'store' | 'product' | 'sku' | 'listing';
  costListingId?: string; costPage?: number; costSearch?: string; costSort?: 'key' | 'valid_from'; costDescending?: boolean;
  editMappingId?: string; mappingPage?: number; mappingDate?: string; mappingSearch?: string; mappingSort?: 'key' | 'name';
  mappingStatus?: 'all' | 'mapped' | 'missing'; mappingDescending?: boolean;
  sourceKind?: PostingKind; sourcePage?: number; sourceSearch?: string; sourceDescending?: boolean; sourceOrderId?: string;
  detailDimension?: SourceDimension; detailChannelId?: string; detailStoreId?: string; detailPage: number;
  detailSearch: string; detailSort: 'key' | 'net_sales' | 'accounted_contribution' | 'order_count'; detailDescending: boolean };
const FIELDS = { workspaceId: 'workspace_id', datasetId: 'dataset_id', datasetPage: 'dataset_page', start: 'start', end: 'end',
  conversationId: 'conversation', conversationPage: 'conversation_page', questionPage: 'question_page', assistantViews: 'assistant_views', selection: 'selected_rows',
  groupCondition: 'group_condition', conditionGrain: 'condition_grain', conditionStart: 'condition_start', conditionEnd: 'condition_end',
  channelTrendMetric: 'channel_trend_metric', rankPage: 'rank_page', rankSearch: 'rank_search', rankSort: 'rank_sort', rankDescending: 'rank_descending', rankGrain: 'rank_grain', profitGroup: 'profit_group', profitView: 'profit_view',
  channelId: 'channel_id', storeId: 'store_id', productId: 'product_id', skuId: 'sku_id', listingId: 'listing_id', category: 'category',
  costAsOf: 'cost_as_of', catalogPage: 'catalog_page', catalogSort: 'catalog_sort', catalogDescending: 'catalog_descending',
  reportType: 'report_type', reportSort: 'report_sort', reportSearch: 'report_search', reportColumns: 'report_columns',
  reportDescending:'report_descending', reportPage:'report_page', viewsPage:'views_page', savedTopic:'saved_topic',
  catalogSearch: 'catalog_search', catalogCondition: 'catalog_condition', historySku: 'history_sku', historyPage: 'history_page', costOperation: 'cost_operation', operationPage: 'operation_page',
  refundReasonId: 'refund_reason_id', refundType: 'refund_type', refundSearch: 'refund_search', refundPage: 'refund_page',
  refundSort: 'refund_sort', refundDescending: 'refund_descending', reasonPage: 'reason_page',
  interval: 'interval', refundBasis: 'refund_basis', channelMetric: 'channel_metric', channelPage: 'channel_page', trendPage: 'trend_page', targetPage: 'target_page',
  targetMonth: 'target_month', editStoreId: 'edit_store_id', detailDimension: 'detail', detailChannelId: 'detail_channel_id',
  filterKind: 'filter', filterPage: 'filter_page', filterSearch: 'filter_search', filterSort: 'filter_sort', filterDescending: 'filter_descending',
  qualityKey: 'quality', evidencePage: 'evidence_page', evidenceSearch: 'evidence_search', evidenceSort: 'evidence_sort', evidenceDescending: 'evidence_descending',
  evidenceRecord: 'evidence_record', evidenceEventPage: 'evidence_event_page',
  costListingId: 'cost_listing_id', costPage: 'cost_page', costSearch: 'cost_search', costSort: 'cost_sort', costDescending: 'cost_descending',
  editMappingId: 'edit_mapping_id', mappingPage: 'mapping_page', mappingDate: 'mapping_date', mappingSearch: 'mapping_search', mappingSort: 'mapping_sort',
  mappingDescending: 'mapping_descending', mappingStatus: 'mapping_status',
  sourceKind: 'source_kind', sourcePage: 'source_page', sourceSearch: 'source_search',
  sourceDescending: 'source_descending', sourceOrderId: 'source_order_id',
  detailStoreId: 'detail_store_id', detailPage: 'detail_page', detailSearch: 'detail_search', detailSort: 'detail_sort', detailDescending: 'detail_descending' } as const;
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
export function readOverviewLocation(search: string): OverviewLocation {
  const p = new URLSearchParams(search);
  for (const key of Object.values(FIELDS)) if (p.getAll(key).length > 1) throw new Error('链接中有重复的范围参数，请重新选择。');
  const id = (key: string) => { const value = p.get(key); if (value === null) return undefined;
    if (!identifier.safeParse(value).success) throw new Error('链接中的对象编号无效，请重新选择。'); return value; };
  const date = (key: string) => { const value = p.get(key); if (value === null) return undefined;
    if (!validDate(value)) throw new Error('链接中的日期无效，请重新选择。'); return value; };
  const page = (key: string) => { const value = p.get(key) ?? '1'; if (!/^[1-9]\d{0,5}$/.test(value)) throw new Error('链接中的页码无效。'); return Number(value); };
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = p.get(key) ?? fallback; if (!allowed.includes(value as T)) throw new Error('链接中的查看方式无效。'); return value as T; };
  const text = (key: string) => { const value = p.get(key) ?? ''; if (value.length > 200) throw new Error('搜索内容过长，请缩短后重试。'); return value; };
  const start = date('start'), end = date('end'), targetMonth = date('target_month');
  if ((start && end && start > end) || (targetMonth && !targetMonth.endsWith('-01'))) throw new Error('日期范围或目标月份无效。');
  const detail = p.get('detail');
  if (detail !== null && !Object.hasOwn(DIMENSION_LABELS, detail)) throw new Error('明细查看方式无效。');
  const filter = p.get('filter');
  if (filter !== null && !Object.hasOwn(REFERENCE_LABELS, filter)) throw new Error('筛选目录无效。');
  const groupCondition = p.has('group_condition') ? choice('group_condition', Object.keys(PRODUCT_CONDITIONS) as ProductCondition[], 'incomplete') : undefined;
  const conditionGrain = p.has('condition_grain') ? choice('condition_grain', ['product', 'sku', 'listing'] as const, 'product') : undefined;
  const conditionStart = date('condition_start'), conditionEnd = date('condition_end');
  if ((groupCondition || conditionGrain || conditionStart || conditionEnd)
    && (!groupCondition || !conditionGrain || !conditionStart || !conditionEnd || conditionStart > conditionEnd)) {
    throw new Error('商品筛选规则或判断日期不完整，请重新选择。');
  }
  if (groupCondition === 'missing_mapping' && conditionGrain !== 'listing') throw new Error('请按平台货号查找付款时没有对应标准规格的商品。');
  const sourceKind = p.has('source_kind') ? choice('source_kind', ['sale', 'refund', 'expense'] as const, 'sale') : undefined;
  if (sourceKind && ['detail', 'filter', 'quality', 'edit_store_id'].some((key) => p.has(key))) throw new Error('请选择一种明细查看方式。');
  const quality = p.get('quality');
  const conversationId = p.get('conversation') ?? undefined;
  if (conversationId && !z.string().uuid().safeParse(conversationId).success) throw new Error('对话链接无效，请重新选择对话。');
  const assistantViews = readAssistantViews(p.get('assistant_views'));
  let selection: EvidenceSelection | undefined;
  if (p.has('selected_rows')) {
    try {
      const raw = p.get('selected_rows')!;
      if (raw.length > 1200) throw new Error();
      selection = selectionSchema.parse(JSON.parse(raw));
    } catch { throw new Error('所选明细链接无效，请从对话中重新选择。'); }
  }
  if ((assistantViews.length || selection) && !conversationId) throw new Error('助手查看位置需要对应的对话。');
  if (quality !== null && !qualityKey.safeParse(quality).success) throw new Error('核算提醒类型无效。');
  return { workspaceId: id('workspace_id'), datasetId: id('dataset_id'), datasetPage: page('dataset_page'), start, end,
    conversationId, conversationPage: page('conversation_page'), questionPage: page('question_page'), assistantViews, selection,
    channelId: id('channel_id'), storeId: id('store_id'), productId: id('product_id'), skuId: id('sku_id'), listingId: id('listing_id'), category: p.has('category') ? text('category') : undefined,
    filterKind: filter ? filter as ReferenceKind : undefined, filterPage: page('filter_page'), filterSearch: text('filter_search'),
    filterSort: choice('filter_sort', ['name', 'key'], 'name'), filterDescending: choice('filter_descending', ['true', 'false'], 'false') === 'true',
    qualityKey: quality ? quality as QualityKey : undefined, evidencePage: page('evidence_page'), evidenceSearch: text('evidence_search'),
    evidenceSort: choice('evidence_sort', ['key', 'name', 'date'], 'key'), evidenceDescending: choice('evidence_descending', ['true', 'false'], 'false') === 'true',
    evidenceRecord: id('evidence_record'), evidenceEventPage: page('evidence_event_page'),
    groupCondition, conditionGrain, conditionStart, conditionEnd,
    costListingId: id('cost_listing_id'), costPage: page('cost_page'), costSearch: text('cost_search'),
    costSort: choice('cost_sort', ['valid_from', 'key'] as const, 'valid_from'), costDescending: choice('cost_descending', ['true', 'false'], 'true') === 'true',
    editMappingId: id('edit_mapping_id'), mappingPage: page('mapping_page'), mappingDate: date('mapping_date'), mappingSearch: text('mapping_search'),
    mappingStatus: choice('mapping_status', ['all', 'mapped', 'missing'] as const, 'all'),
    mappingSort: choice('mapping_sort', ['key', 'name'] as const, 'key'), mappingDescending: choice('mapping_descending', ['true', 'false'], 'false') === 'true',
    sourceKind, sourcePage: page('source_page'), sourceOrderId: id('source_order_id'), sourceSearch: text('source_search'),
    sourceDescending: choice('source_descending', ['true', 'false'], 'true') === 'true',
    costAsOf: date('cost_as_of'), catalogPage: page('catalog_page'), catalogSearch: text('catalog_search'),
    catalogSort: choice('catalog_sort', ['key', 'name', 'unit_cost', 'sales_amount', 'change_rate', 'contribution_profit'] as const, 'key'),
    catalogCondition: choice('catalog_condition', ['all','missing','rising','negative','low_margin'] as const, 'all'),
    reportType: choice('report_type', reportTypes, 'daily'), reportSearch: text('report_search'), reportSort: id('report_sort'),
    reportColumns: p.get('report_columns') ? z.string().max(1000).regex(/^[a-z_]+(,[a-z_]+)*$/).parse(p.get('report_columns')) : undefined,
    reportDescending: choice('report_descending',['true','false'],'true') === 'true', reportPage: page('report_page'), viewsPage:page('views_page'), savedTopic:id('saved_topic'),
    catalogDescending: choice('catalog_descending', ['true','false'], 'false') === 'true', historySku: id('history_sku'), historyPage: page('history_page'), costOperation: id('cost_operation'), operationPage: page('operation_page'),
    refundReasonId: id('refund_reason_id'), refundType: p.has('refund_type') ? choice('refund_type', ['refund_only', 'return', 'unshipped_cancel'] as const, 'refund_only') : undefined,
    refundSearch: text('refund_search'), refundPage: page('refund_page'), reasonPage: page('reason_page'),
    refundSort: choice('refund_sort', ['date', 'amount', 'cost', 'order_id'] as const, 'date'), refundDescending: choice('refund_descending', ['true', 'false'], 'true') === 'true',
    interval: choice('interval', ['day', 'week'], 'day'), refundBasis: choice('refund_basis', ['payment', 'occurred'], 'payment'),
    channelMetric: choice('channel_metric', ['net_sales', 'accounted_contribution'], 'net_sales'),
    channelTrendMetric: choice('channel_trend_metric', ['net_sales', 'contribution_profit', 'contribution_margin', 'refund_ratio'] as const, 'net_sales'),
    rankPage: page('rank_page'), rankSearch: text('rank_search'), rankSort: choice('rank_sort', Object.keys(RANK_METRICS) as RankMetric[], 'accounted_contribution'),
    rankDescending: choice('rank_descending', ['true', 'false'], 'true') === 'true', profitView: choice('profit_view', ['current', 'change'] as const, 'current'),
    profitGroup: choice('profit_group', ['channel', 'store', 'product', 'sku', 'listing'] as const, 'channel'), rankGrain: choice('rank_grain', ['product', 'sku', 'listing'] as const, 'product'),
    channelPage: page('channel_page'), trendPage: page('trend_page'), targetPage: page('target_page'), targetMonth, editStoreId: id('edit_store_id'),
    detailDimension: detail ? detail as SourceDimension : undefined, detailChannelId: id('detail_channel_id'), detailStoreId: id('detail_store_id'),
    detailPage: page('detail_page'), detailSearch: text('detail_search'), detailSort: choice('detail_sort', ['key', 'net_sales', 'accounted_contribution', 'order_count'], 'net_sales'),
    detailDescending: choice('detail_descending', ['true', 'false'], 'true') === 'true' };
}
export function overviewUrl(current: string, change: Partial<OverviewLocation>) {
  const url = new URL(current, 'http://shopgate.local');
  // Keep only product-owned scope. Login/links cannot carry arbitrary destinations or identities.
  for (const key of [...url.searchParams.keys()]) if (!(Object.values(FIELDS) as string[]).includes(key)) url.searchParams.delete(key);
  const before = readOverviewLocation(url.searchParams.toString());
  if (('workspaceId' in change && change.workspaceId !== before.workspaceId)
      || ('datasetId' in change && change.datasetId !== before.datasetId)) {
    const workspaceId = 'workspaceId' in change ? change.workspaceId : before.workspaceId;
    url.search = ''; if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  } else {
    if ('conversationId' in change && change.conversationId !== before.conversationId) {
      url.searchParams.delete('selected_rows'); url.searchParams.delete('assistant_views'); url.searchParams.delete('question_page');
    }
    if (['start', 'end', 'channelId', 'storeId', 'productId', 'skuId', 'listingId', 'category', 'refundBasis', 'rankSearch', 'groupCondition', 'conditionGrain', 'conditionStart', 'conditionEnd'].some((key) => key in change)) {
      for (const key of ['catalog_page', 'history_sku', 'history_page', 'refund_page', 'reason_page', 'cost_listing_id', 'cost_search', 'cost_page', 'edit_mapping_id', 'mapping_page', 'source_page', 'source_order_id', 'rank_page', 'channel_page', 'trend_page', 'target_page', 'detail_page', 'filter_page', 'edit_store_id', 'detail_channel_id', 'detail_store_id', 'evidence_page', 'evidence_record', 'evidence_event_page']) url.searchParams.delete(key);
    }
    if ('groupCondition' in change && !change.groupCondition) {
      for (const key of ['condition_grain', 'condition_start', 'condition_end']) url.searchParams.delete(key);
    }
    if ('channelId' in change && change.channelId !== before.channelId && !('storeId' in change)) url.searchParams.delete('store_id');
    if ((('channelId' in change && change.channelId !== before.channelId) || ('storeId' in change && change.storeId !== before.storeId)) && !('listingId' in change)) url.searchParams.delete('listing_id');
    if ('productId' in change && change.productId !== before.productId && !('skuId' in change)) url.searchParams.delete('sku_id');
    if ('category' in change && change.category !== before.category) {
      if (!('productId' in change)) url.searchParams.delete('product_id');
      if (!('skuId' in change)) url.searchParams.delete('sku_id');
    }
    if (['costAsOf', 'catalogSearch', 'catalogSort', 'catalogDescending', 'catalogCondition'].some((key) => key in change)) {
      url.searchParams.delete('catalog_page'); url.searchParams.delete('history_page'); url.searchParams.delete('history_sku');
    }
    if ('costOperation' in change) url.searchParams.delete('operation_page');
    if (['start','end','channelId','storeId','skuId','productId','listingId','category','refundBasis','rankSearch','groupCondition','conditionStart','conditionEnd','refundReasonId','refundType','refundSearch','reportSort','reportSearch','reportDescending','reportType'].some(k => k in change)) url.searchParams.delete('report_page');
    if ('historySku' in change) url.searchParams.delete('history_page');
    if (['refundBasis', 'refundReasonId', 'refundType', 'refundSearch', 'refundSort', 'refundDescending'].some((key) => key in change)) {
      url.searchParams.delete('refund_page'); url.searchParams.delete('reason_page');
    }
    if ('filterKind' in change || 'filterSearch' in change || 'filterSort' in change || 'filterDescending' in change) url.searchParams.delete('filter_page');
    if (['mappingDate', 'mappingSearch', 'mappingStatus', 'mappingSort', 'mappingDescending'].some((key) => key in change)) url.searchParams.delete('mapping_page');
    if (['sourceKind', 'sourceOrderId', 'sourceSearch', 'sourceDescending'].some((key) => key in change)) url.searchParams.delete('source_page');
    if ('costListingId' in change) for (const key of ['cost_page', 'cost_search', 'cost_sort', 'cost_descending']) url.searchParams.delete(key);
    if (['costSearch', 'costSort', 'costDescending', 'mappingDate'].some((key) => key in change)) url.searchParams.delete('cost_page');
    if (change.costListingId) for (const key of ['edit_mapping_id', 'filter', 'detail', 'edit_store_id', 'quality', 'source_kind']) url.searchParams.delete(key);
    if (change.editMappingId || change.filterKind || change.detailDimension || change.qualityKey || change.editStoreId || change.sourceKind) url.searchParams.delete('cost_listing_id');
    if (change.editMappingId) for (const key of ['filter', 'detail', 'edit_store_id', 'quality', 'source_kind']) url.searchParams.delete(key);
    if (change.filterKind || change.detailDimension || change.qualityKey || change.editStoreId || change.sourceKind) url.searchParams.delete('edit_mapping_id');
    if (change.filterKind || change.detailDimension || change.qualityKey || change.editStoreId || ('sourceKind' in change && !change.sourceKind)) {
      for (const key of ['source_kind', 'source_page', 'source_order_id', 'source_search', 'source_descending']) url.searchParams.delete(key);
    }
    if (change.sourceKind) for (const key of ['filter', 'detail', 'edit_store_id', 'quality']) url.searchParams.delete(key);
    if (change.filterKind) { url.searchParams.delete('detail'); url.searchParams.delete('edit_store_id'); }
    if (change.detailDimension) { url.searchParams.delete('filter'); url.searchParams.delete('edit_store_id'); }
    if (change.editStoreId) { url.searchParams.delete('filter'); url.searchParams.delete('detail'); }
    if (change.filterKind || change.detailDimension || change.editStoreId) url.searchParams.delete('quality');
    if (change.qualityKey) for (const key of ['filter', 'detail', 'edit_store_id']) url.searchParams.delete(key);
    if (['qualityKey', 'evidenceSearch', 'evidenceSort', 'evidenceDescending'].some((key) => key in change)) {
      for (const key of ['evidence_page', 'evidence_record', 'evidence_event_page']) url.searchParams.delete(key);
    }
    if ('evidenceRecord' in change) url.searchParams.delete('evidence_event_page');
    if ('detailDimension' in change || 'detailSearch' in change || 'detailSort' in change || 'detailDescending' in change) url.searchParams.delete('detail_page');
    if ('targetMonth' in change) { url.searchParams.delete('target_page'); url.searchParams.delete('edit_store_id'); }
    if (['rankSearch', 'rankSort', 'rankDescending', 'rankGrain', 'profitGroup'].some((key) => key in change)) url.searchParams.delete('rank_page');
    if ('interval' in change) url.searchParams.delete('trend_page');
    if ('channelMetric' in change) url.searchParams.delete('channel_page');
  }
  for (const [field, key] of Object.entries(FIELDS)) if (field in change) {
    const value = change[field as keyof OverviewLocation];
    const defaults: Record<string, unknown> = { reportType: 'daily', reportDescending:true, costSort: 'valid_from', costDescending: true, mappingStatus: 'all', mappingSort: 'key', mappingDescending: false, sourceDescending: true, channelTrendMetric: 'net_sales', rankSort: 'accounted_contribution', rankDescending: true, rankGrain: 'product', profitGroup: 'channel', profitView: 'current', refundSort: 'date', refundDescending: true, catalogSort: 'key', catalogCondition: 'all', catalogDescending: false, interval: 'day', refundBasis: 'payment', channelMetric: 'net_sales', detailSort: 'net_sales', detailDescending: true, filterSort: 'name', filterDescending: false, evidenceSort: 'key', evidenceDescending: false };
    if (field === 'selection') {
      if (!value) url.searchParams.delete(key);
      else url.searchParams.set(key, JSON.stringify(selectionSchema.parse(value)));
      continue;
    }
    if (field === 'assistantViews') {
      if (!value || (value as AssistantViewState[]).length === 0) url.searchParams.delete(key);
      else url.searchParams.set(key, JSON.stringify(readAssistantViews(JSON.stringify(value))));
      continue;
    }
    if (value === undefined || (value === '' && field !== 'category') || (field.endsWith('Page') && value === 1) || defaults[field] === value) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  readOverviewLocation(url.searchParams.toString());
  return `${url.pathname}${url.search}`;
}
export function sectionHref(section: BusinessSection, location: Partial<OverviewLocation>) {
  const { workspaceId, datasetId, start, end, refundBasis, channelId, storeId, productId, skuId, listingId, category, interval, rankSearch, groupCondition, conditionGrain, conditionStart, conditionEnd } = location;
  return overviewUrl('/bi/' + section, { workspaceId, datasetId, start, end, refundBasis, channelId, storeId, productId, skuId, listingId, category, interval, rankSearch, groupCondition, conditionGrain, conditionStart, conditionEnd });
}

export function overviewLoginReturnPath(search: Record<string, string | string[] | undefined>, section: BusinessSection | 'assistant' = 'overview') {
  const p = new URLSearchParams();
  for (const key of Object.values(FIELDS)) {
    if (Array.isArray(search[key])) throw new Error('链接中有重复的范围参数，请重新选择。');
    if (typeof search[key] === 'string') p.set(key, search[key] as string);
  }
  const scope = readOverviewLocation(p.toString());
  return overviewUrl('/bi/' + section, scope);
}
export function overviewQuery(scope: OverviewLocation): Record<string, unknown> {
  return { ...(scope.start ? { start: scope.start } : {}), ...(scope.end ? { end: scope.end } : {}),
    ...(scope.groupCondition && { group_condition: scope.groupCondition, condition_grain: scope.conditionGrain,
      condition_start: scope.conditionStart, condition_end: scope.conditionEnd }),
    ...(scope.refundType && { refund_type: scope.refundType }), ...(scope.refundReasonId && { refund_reason_id: scope.refundReasonId }),
    ...(scope.refundSearch && { refund_search: scope.refundSearch }),
    ...(scope.rankSearch ? { search: scope.rankSearch } : {}), refund_basis: scope.refundBasis, channel_ids: scope.channelId ? [scope.channelId] : [], store_ids: scope.storeId ? [scope.storeId] : [],
    product_ids: scope.productId ? [scope.productId] : [], sku_ids: scope.skuId ? [scope.skuId] : [],
    listing_ids: scope.listingId ? [scope.listingId] : [], ...(scope.category !== undefined ? { category: scope.category } : {}) };
}
export function referenceOptions(scope: OverviewLocation) {
  const kind = scope.filterKind ?? 'product';
  return { kind, search: scope.filterSearch, sort: scope.filterSort, descending: scope.filterDescending, page: scope.filterPage, page_size: 20,
    ...(['store', 'listing'].includes(kind) && scope.channelId ? { channel_id: scope.channelId } : {}),
    ...(kind === 'listing' && scope.storeId ? { store_id: scope.storeId } : {}),
    ...(kind === 'sku' && scope.productId ? { product_id: scope.productId } : {}),
    ...(['product', 'sku'].includes(kind) && scope.category !== undefined ? { category: scope.category } : {}) };
}
export function referenceSelection(kind: ReferenceKind, row: ReferenceRow): Partial<OverviewLocation> {
  if (kind !== 'category' && !identifier.safeParse(row.key).success) throw new Error('所选对象编号无效，请重新读取目录。');
  const fields = { channel: 'channelId', store: 'storeId', product: 'productId', sku: 'skuId', listing: 'listingId', category: 'category' } as const;
  return { [fields[kind]]: row.key, ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.store_id ? { storeId: row.store_id } : {}), ...(row.product_id ? { productId: row.product_id } : {}),
    filterKind: undefined, filterPage: 1, filterSearch: '' };
}
export function scopeMatches(workspaceId: string, dataset: { dataset_id: string; version: number },
  result: { workspace_id: string; dataset_id: string; version: number; accounting_revision: number }) {
  return workspaceId === result.workspace_id && dataset.dataset_id === result.dataset_id
    && dataset.version === result.version && result.version === result.accounting_revision;
}
