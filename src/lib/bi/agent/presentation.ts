import { decimalLabel } from '../data-contracts';
import { QUALITY_LABELS, type LedgerRow } from '../overview-contracts';
import { BI_METRICS } from './result-contracts';

/** Exact population/capability notes accompany every tool preview and page. */
export const BI_RESULT_READING_GUIDE = {
  summary_label: '当前查询范围合计（包含符合当前筛选的未归属费用或待映射交易）',
  population: '结果仅包含此范围内有经营记录的分组，不是主数据目录中的全部商品、规格或店铺。total包含未归属项；不得从前20行推断其余分组。',
  unattributed: 'key为__unattributed__的行不是商品或店铺，可能同时包含待映射交易和未分摊费用。summary不能改称已归属商品合计；若另算已归属金额须取得完整依据，订单数须去重，比例不可相加。',
  quality: '依据表每行展示已验证的待核算原因和缺项条数。同一明细可能同时缺金额、成本等依据，各类条数不能相加当作独立记录数。',
  provenance: 'version 和 accounting_revision 是数字版本。data_cutoff 是数据截止日期。不要把日期写成核算版本。',
  payment_missing_reasons: 'quality.payment_missing_reasons 按原付款明细去重，missing_cost 是缺少适用成本，missing_mapping 是缺少换算对应，missing_fx 是缺少汇率。各类可能重叠。只在证据列出具体原因时说明原因。已有合计及单规格依据能回答时无需重新读取同一批订单。',
  order_count: '付款订单按订单编号去重。同一订单可含多件商品，各商品订单数之和可高于合计。对比分组时用同范围 summary 的 order_count。',
  allowed_sort_fields: [...BI_METRICS, 'key'],
  unavailable: '当前没有按待核算条数排序或按指标正负筛选的查询参数，不能推荐执行这些操作。可使用已支持指标排序，或查看完整依据中的待核算原因。',
} as const;

/** An order may contribute to multiple products. Compare only a complete set of groups. */
export function orderCountComparison(unique: unknown, total: number, rows: LedgerRow[]) {
  if (typeof unique !== 'number' || !Number.isSafeInteger(unique) || unique < 0 || rows.length !== total) return;
  let grouped = 0;
  for (const row of rows) {
    const count = row.metrics.order_count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
    grouped += count;
  }
  if (!Number.isSafeInteger(grouped) || grouped <= unique) return;
  return { distinct_orders: unique, sum_of_group_counts: grouped, repeated_group_appearances: grouped - unique,
    explanation: `去重后共 ${unique} 笔订单。各组笔数相加为 ${grouped}，其中有 ${grouped - unique} 次重复计入。` };
}

export function displayBiQuality(quality: LedgerRow['quality']) {
  return Object.entries(QUALITY_LABELS).flatMap(([key, label]) => {
    const count = quality[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? [{ key, label, count }] : [];
  });
}

/** Shared with the UI: these are labels, never inputs to accounting. */
export function displayBiMetrics(metrics: LedgerRow['metrics']) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key,
    decimalLabel(value, key.endsWith('_ratio') || key === 'contribution_margin')]));
}
export function displayBiRows(rows: LedgerRow[]) {
  return rows.map((row) => ({ key: row.key, name: row.name,
    is_unattributed: row.key === '__unattributed__',
    metrics: displayBiMetrics(row.metrics), quality: displayBiQuality(row.quality) }));
}
