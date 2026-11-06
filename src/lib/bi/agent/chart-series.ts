import type { z } from 'zod';
import type { ledgerRowSchema } from '../overview-contracts';
import type { biMetric } from './result-contracts';

/** Number is used only for coordinates. Raw decimals remain the source labels. */
export function chartSeries(input: z.infer<typeof ledgerRowSchema>[], metric: z.infer<typeof biMetric>, chronological: boolean, days = 1) {
  const sorted = chronological ? [...input].sort((a, b) => a.key.localeCompare(b.key)) : input;
  const rows = sorted.map((r, index) => {
    const raw = r.metrics[metric] ?? null, n = raw === null ? null : Number(raw);
    const value = n !== null && Number.isFinite(n) ? n : null;
    const previous = index > 0 ? Date.parse(sorted[index - 1].key) : NaN, current = Date.parse(r.key);
    return { key: r.key, name: r.name, raw, value, gapBefore: chronological && index > 0
      && (!Number.isFinite(current) || !Number.isFinite(previous) || current - previous !== days * 86400000) };
  });
  const values = rows.flatMap((r) => r.value === null ? [] : [r.value]);
  return { rows, min: Math.min(0, ...values), max: Math.max(0, ...values) };
}
