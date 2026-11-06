// Browser-safe presentation and URL scope. Accounting remains in the ledger.
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const version = z.number().int().positive().safe();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const metricValue = z.union([decimal, z.number().int().safe(), z.null()]);
const metrics = z.record(z.string(), metricValue);
const quality = z.record(z.string(), z.unknown());
const summary = z.object({ metrics, quality });
const range = z.object({ start: z.string().nullable(), end: z.string().nullable(), refund_basis: z.enum(['payment', 'occurred']) });
const page = { total: z.number().int().nonnegative(), page: z.number().int().positive(), page_size: z.literal(20) };
export const ledgerRowSchema = z.object({ key: z.string(), name: z.string(), metrics, quality,
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
  previous: z.object({ range, summary, history_sufficient: z.boolean() }).nullable(),
  comparison: z.record(z.string(), comparison),
  trend: z.object({ interval: z.enum(['day', 'week']), rows: z.array(z.object({ key: z.string(),
    start: z.string(), end: z.string(), state: z.enum(['recorded', 'no_records']),
    metrics: metrics.nullable(), quality: quality.nullable() })), note: z.string().optional() }),
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

export type OverviewLocation = { workspaceId?: string; datasetId?: string; datasetPage: number;
  start?: string; end?: string; channelId?: string; storeId?: string; productId?: string; skuId?: string; listingId?: string; category?: string;
  interval: 'day' | 'week'; refundBasis: 'payment' | 'occurred'; channelMetric: 'net_sales' | 'accounted_contribution';
  channelPage: number; trendPage: number; targetPage: number; targetMonth?: string; editStoreId?: string;
  detailDimension?: SourceDimension; detailChannelId?: string; detailStoreId?: string; detailPage: number;
  detailSearch: string; detailSort: 'key' | 'net_sales' | 'accounted_contribution' | 'order_count'; detailDescending: boolean };
const FIELDS = { workspaceId: 'workspace_id', datasetId: 'dataset_id', datasetPage: 'dataset_page', start: 'start', end: 'end',
  channelId: 'channel_id', storeId: 'store_id', productId: 'product_id', skuId: 'sku_id', listingId: 'listing_id', category: 'category',
  interval: 'interval', refundBasis: 'refund_basis', channelMetric: 'channel_metric', channelPage: 'channel_page', trendPage: 'trend_page', targetPage: 'target_page',
  targetMonth: 'target_month', editStoreId: 'edit_store_id', detailDimension: 'detail', detailChannelId: 'detail_channel_id',
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
  return { workspaceId: id('workspace_id'), datasetId: id('dataset_id'), datasetPage: page('dataset_page'), start, end,
    channelId: id('channel_id'), storeId: id('store_id'), productId: id('product_id'), skuId: id('sku_id'), listingId: id('listing_id'), category: text('category') || undefined,
    interval: choice('interval', ['day', 'week'], 'day'), refundBasis: choice('refund_basis', ['payment', 'occurred'], 'payment'),
    channelMetric: choice('channel_metric', ['net_sales', 'accounted_contribution'], 'net_sales'),
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
    if (['start', 'end', 'channelId', 'storeId', 'productId', 'skuId', 'listingId', 'category', 'refundBasis'].some((key) => key in change)) {
      for (const key of ['channel_page', 'trend_page', 'target_page', 'detail_page', 'edit_store_id', 'detail_channel_id', 'detail_store_id']) url.searchParams.delete(key);
    }
    if ('channelId' in change && change.channelId !== before.channelId && !('storeId' in change)) url.searchParams.delete('store_id');
    if ('detailDimension' in change || 'detailSearch' in change || 'detailSort' in change || 'detailDescending' in change) url.searchParams.delete('detail_page');
    if ('targetMonth' in change) { url.searchParams.delete('target_page'); url.searchParams.delete('edit_store_id'); }
    if ('interval' in change) url.searchParams.delete('trend_page');
    if ('channelMetric' in change) url.searchParams.delete('channel_page');
  }
  for (const [field, key] of Object.entries(FIELDS)) if (field in change) {
    const value = change[field as keyof OverviewLocation];
    const defaults: Record<string, unknown> = { interval: 'day', refundBasis: 'payment', channelMetric: 'net_sales', detailSort: 'net_sales', detailDescending: true };
    if (value === undefined || value === '' || (field.endsWith('Page') && value === 1) || defaults[field] === value) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  readOverviewLocation(url.searchParams.toString());
  return `${url.pathname}${url.search}`;
}
export function overviewLoginReturnPath(search: Record<string, string | string[] | undefined>) {
  const p = new URLSearchParams();
  for (const key of Object.values(FIELDS)) {
    if (Array.isArray(search[key])) throw new Error('链接中有重复的范围参数，请重新选择。');
    if (typeof search[key] === 'string') p.set(key, search[key] as string);
  }
  const scope = readOverviewLocation(p.toString());
  return overviewUrl('/bi/overview', scope);
}
export function overviewQuery(scope: OverviewLocation): Record<string, unknown> {
  return { ...(scope.start ? { start: scope.start } : {}), ...(scope.end ? { end: scope.end } : {}),
    refund_basis: scope.refundBasis, channel_ids: scope.channelId ? [scope.channelId] : [], store_ids: scope.storeId ? [scope.storeId] : [],
    product_ids: scope.productId ? [scope.productId] : [], sku_ids: scope.skuId ? [scope.skuId] : [],
    listing_ids: scope.listingId ? [scope.listingId] : [], ...(scope.category ? { category: scope.category } : {}) };
}
export function scopeMatches(workspaceId: string, dataset: { dataset_id: string; version: number },
  result: { workspace_id: string; dataset_id: string; version: number; accounting_revision: number }) {
  return workspaceId === result.workspace_id && dataset.dataset_id === result.dataset_id
    && dataset.version === result.version && result.version === result.accounting_revision;
}
