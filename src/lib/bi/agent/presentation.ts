import { decimalLabel } from '../data-contracts';
import type { LedgerRow } from '../overview-contracts';

/** Shared with the UI: these are labels, never inputs to accounting. */
export function displayBiMetrics(metrics: LedgerRow['metrics']) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key,
    decimalLabel(value, key.endsWith('_ratio') || key === 'contribution_margin')]));
}
export function displayBiRows(rows: LedgerRow[]) {
  return rows.map((row) => ({ key: row.key, name: row.name, metrics: displayBiMetrics(row.metrics) }));
}
