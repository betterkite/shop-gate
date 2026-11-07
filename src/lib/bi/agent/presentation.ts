import { decimalLabel } from '../data-contracts';
import { QUALITY_LABELS, type LedgerRow } from '../overview-contracts';
import { BI_METRICS } from './result-contracts';

/** Exact population/capability notes accompany every tool preview and page. */
export const BI_RESULT_READING_GUIDE = {
  summary_label: '当前查询范围合计（包含符合当前筛选的未归属费用或待映射交易）',
  population: '结果仅包含此范围内有经营记录的分组，不是主数据目录中的全部商品、规格或店铺。total包含未归属项；不得从前20行推断其余分组。',
  unattributed: 'key为__unattributed__的行不是商品或店铺，可能同时包含待映射交易和未分摊费用。summary不能改称已归属商品合计；若另算已归属金额须取得完整依据，订单数须去重，比例不可相加。',
  quality: '依据表每行展示已验证的待核算原因和缺项条数。同一明细可能同时缺金额、成本等依据，各类条数不能相加当作独立记录数。',
  allowed_sort_fields: [...BI_METRICS, 'key'],
  unavailable: '当前没有按待核算条数排序或按指标正负筛选的查询参数，不能推荐执行这些操作。可使用已支持指标排序，或查看完整依据中的待核算原因。',
} as const;

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
