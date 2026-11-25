import { z } from 'zod';
import { overviewQuery, type OverviewLocation } from './overview-contracts';

import { reportType } from './report-config';
export { reportTypes, REPORT_NAMES } from './report-config';
const page = z.number().int().positive();
const scope = { workspace_id: z.string(), dataset_id: z.string(), version: page };
export const reportTable = z.object({ ...scope, accounting_revision: page, report_type: reportType,
  page, page_size: z.literal(20), total: z.number().int().nonnegative(), labels: z.record(z.string(), z.string()),
  columns: z.array(z.string()), sort: z.string(), descending: z.boolean(),
  range: z.object({ start: z.string().nullable(), end: z.string().nullable(), refund_basis: z.string() }),
  rows: z.array(z.object({ id: z.string(), values: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) })),
});
const ids = z.array(z.string()).max(1).default([]);
const filters = z.object({ start: z.string().nullish(), end: z.string().nullish(),
  refund_basis: z.enum(['payment','occurred']).default('payment'), channel_ids: ids, store_ids: ids,
  sku_ids: ids, listing_ids: ids, product_ids: ids, category: z.string().nullish(), search: z.string().default(''),
  refund_type: z.enum(['return','refund_only','unshipped_cancel']).nullish(), refund_reason_id: z.string().nullish(),
  refund_search: z.string().default(''), condition_grain: z.enum(['listing','product','sku']).nullish(),
  group_condition: z.enum(['negative','low_margin','high_refund','incomplete','missing_cost','missing_mapping']).nullish(),
  condition_start: z.string().nullish(), condition_end: z.string().nullish(),
});
export const view = z.object({ view_id: z.string().uuid(), name: z.string(), revision: page, saved_version: page.nullable(),
  report_type: reportType, topic: z.object({ run_id: z.string().uuid(), conversation_id: z.string().uuid(), dataset_version: page }).nullable(),
  options: z.object({ report_type: reportType, query: filters, search: z.string(), sort: z.string().nullable(),
    columns: z.array(z.string()), descending: z.boolean() }) });
export type ReportView = z.infer<typeof view>;
export const viewList = z.object({ ...scope, page, page_size: z.literal(20), total: z.number().int().nonnegative(), rows: z.array(view) });
export const viewChange = z.object({ ...scope, view });
export function reportOptions(loc: OverviewLocation) {
  return { report_type: loc.reportType ?? 'daily', query: overviewQuery(loc), search: loc.reportSearch ?? '',
    columns: loc.reportColumns?.split(',').filter(Boolean) ?? [], sort: loc.reportSort ?? null,
    descending: loc.reportDescending ?? true, page: loc.reportPage ?? 1 };
}
export function restoreReport(saved: ReportView): Partial<OverviewLocation> {
  const o = saved.options, q = o.query;
  return { reportType: o.report_type, reportSearch: o.search, reportSort: o.sort ?? undefined,
    reportColumns: o.columns.join(',') || undefined, reportDescending: o.descending, reportPage: 1,
    start: q.start ?? undefined, end: q.end ?? undefined, refundBasis: q.refund_basis,
    channelId: q.channel_ids[0], storeId: q.store_ids[0], skuId: q.sku_ids[0], productId: q.product_ids[0],
    listingId: q.listing_ids[0], category: q.category ?? undefined, rankSearch: q.search,
    refundType: q.refund_type ?? undefined, refundReasonId: q.refund_reason_id ?? undefined, refundSearch: q.refund_search,
    conditionGrain: q.condition_grain ?? undefined, conditionStart: q.condition_start ?? undefined, conditionEnd: q.condition_end ?? undefined,
    groupCondition: q.group_condition ?? undefined, savedTopic: saved.topic ? saved.view_id : undefined };
}
