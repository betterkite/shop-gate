import { z } from 'zod';
import { readBi } from './data-browser';
import { decimalLabel, EXPENSE_TYPE_LABELS } from './data-contracts';
import { ledgerTableSchema, scopeMatches } from './overview-contracts';
import { metricUnit, quantityUnit, rankingMetrics, RANK_METRICS } from './sections';

// The public ledger endpoint accepts up to 100 rows per request.
const pageSize = 100;
const exportPage = ledgerTableSchema.extend({ page_size: z.literal(pageSize) });

export function csvCell(value: string, text = false) {
  // Imported names and identifiers are text even if a spreadsheet sees a formula.
  const safe = text && /^(?:\s*[=+@-]|[\t\r\n])/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export async function exportRanking(scope: { workspace_id: string; dataset_id: string; version: number },
  query: Record<string, unknown>, signal: AbortSignal, profit = false) {
  const metrics = rankingMetrics(query, profit);
  const includeUnit = metrics.includes('standard_quantity');
  const feeColumns = !profit && (query.dimension === 'channel' || query.dimension === 'store')
    ? Object.entries(EXPENSE_TYPE_LABELS) : [];
  const headers = ['编号', '名称', ...metrics.map((key) => RANK_METRICS[key] + '（' + metricUnit(key) + '）'),
    ...(includeUnit ? ['标准单位'] : []), ...feeColumns.flatMap(([, name]) => [name + '（元）', name + '已核算部分（元）'])];
  const parts: string[] = ['\uFEFF' + headers.map((value) => csvCell(value)).join(',') + '\r\n'];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; total === undefined || seen.size < total; page++) {
    const body = JSON.stringify({ ...scope, query: { ...query, metrics, page, page_size: pageSize } });
    const result = await readBi('/api/bi/query', exportPage, { method: 'POST', body, signal });
    if (!scopeMatches(scope.workspace_id, scope, result) || result.page !== page
        || (total !== undefined && total !== result.total)
        || result.rows.length !== Math.min(pageSize, result.total - seen.size)) {
      throw new Error('导出期间明细范围发生变化，请刷新后重试。');
    }
    total = result.total;
    for (const row of result.rows) {
      if (seen.has(row.key)) throw new Error('导出期间出现重复记录，请刷新后重试。');
      seen.add(row.key);
      const values = metrics.map((key) => {
        const value = row.metrics[key];
        if (value == null) return '待核算';
        return metricUnit(key) === '%' ? decimalLabel(value, true) : String(value);
      });
      if (includeUnit) values.push(quantityUnit(row.quality));
      for (const [id] of feeColumns) {
        const breakdown = row.expense_breakdown;
        const part = breakdown?.[id];
        const absent = breakdown === undefined ? '待核算' : '0.00';
        values.push(part ? part.amount ?? '待核算' : absent, part ? part.known_amount : absent);
      }
      parts.push([csvCell(row.key, true), csvCell(row.name, true), ...values.map((value, i) => csvCell(value, includeUnit && i === metrics.length))].join(',') + '\r\n');
    }
  }
  signal.throwIfAborted();
  return { file: new Blob(parts, { type: 'text/csv;charset=utf-8' }), total: seen.size };
}
