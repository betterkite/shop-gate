import { z } from 'zod';
export const REPORT_NAMES = {
  daily: '销售日报', channels: '渠道经营报表', stores: '店铺经营报表', products: '商品利润表',
  orders: '订单行明细', refunds: '退款明细', costs: '成本变更记录',
} as const;
export type ReportType = keyof typeof REPORT_NAMES;
export const reportTypes = Object.keys(REPORT_NAMES) as ReportType[];
export const reportType = z.enum(reportTypes as [ReportType, ...ReportType[]]);

export const reportSettings = z.object({
  report_type: reportType, search: z.string().max(200).default(''),
  sort: z.string().regex(/^[a-z_]{1,40}$/).nullable().default(null), descending: z.boolean().default(true),
  columns: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(32).default([]),
}).strict();
