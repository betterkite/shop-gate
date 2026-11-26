import { readBi } from './data-browser';
import { CHOICE_LABELS } from './data-contracts';
import { scopeMatches, sourcePageSchema, type SourcePage } from './overview-contracts';
import { csvCell } from './ranking-export';
import { z } from 'zod';

const pageSchema = sourcePageSchema.extend({ page_size: z.literal(100) });
type Row = SourcePage['rows'][number];
export const refundTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
}).format(new Date(value)) : '未记录';

function fields(row: Row) {
  const numbers = [row.original_amount, row.amount_cny, row.returned_quantity, row.recoverable_quantity,
    row.cancelled_quantity, row.cost_cny];
  return [...[row.source_id, row.order_id, row.platform_order_id, row.line_id, row.store_name, row.listing_name,
    row.paid_at, row.occurred_at, row.refund_type && CHOICE_LABELS[row.refund_type], row.reason, row.currency]
    .map((v) => csvCell(v ?? '', true)), ...numbers.map((v) => csvCell(v ?? '待核算'))].join(',');
}

export async function refundExport(scope: { workspace_id: string; dataset_id: string; version: number },
  options: Record<string, unknown>, signal: AbortSignal) {
  const headers = ['退款编号', '原订单', '平台订单号', '订单行', '店铺', '平台商品', '付款时间', '退款时间',
    '类型', '原因', '原币', '退款原币金额', '退款折合人民币（元）', '退回数量', '可回收数量', '未发货取消数量', '冲回商品成本（元）'];
  const parts = ['\uFEFF' + headers.map((s) => csvCell(s)).join(',') + '\r\n'];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; total === undefined || seen.size < total; page++) {
    const body = JSON.stringify({ ...scope, options: { ...options, kind: 'refund', page, page_size: 100 } });
    const data = await readBi('/api/bi/sources', pageSchema, { method: 'POST', body, signal });
    if (!scopeMatches(scope.workspace_id, scope, data) || data.kind !== 'refund' || page !== data.page ||
        (total !== undefined && total !== data.total) || data.rows.length !== Math.min(100, data.total - seen.size)) {
      throw new Error('退款记录范围已变化，请重新导出。');
    }
    total = data.total;
    for (const row of data.rows) {
      if (seen.has(row.key)) throw new Error('下载时发现重复的退款记录，请刷新后重试。');
      seen.add(row.key); parts.push(fields(row) + '\r\n');
    }
  }
  signal.throwIfAborted();
  return { file: new Blob(parts, { type: 'text/csv;charset=utf-8' }), total: seen.size };
}
