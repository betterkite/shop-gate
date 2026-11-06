import { describe, expect, it } from 'vitest';
import { chartSeries } from './chart-series';
const row = (key: string, value: string | null) => ({ key, name: key, metrics: { net_sales: value }, quality: {} });
describe('verified chart coordinates', () => {
  it('sorts time, preserves unknown and negative values and breaks unrecorded dates', () => {
    const result = chartSeries([row('2026-07-05', '10.10'), row('2026-07-01', '-3.25'), row('2026-07-02', null)], 'net_sales', true);
    expect(result.min).toBe(-3.25); expect(result.max).toBe(10.1);
    expect(result.rows.map((r) => r.raw)).toEqual(['-3.25', null, '10.10']);
    expect(result.rows[1].value).toBeNull(); expect(result.rows[2].gapBefore).toBe(true);
  });
  it('uses the full distribution for the scale even when a later chart page has the extreme', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`p${i}`, i === 24 ? '-900' : '10'));
    expect(chartSeries(rows, 'net_sales', false)).toMatchObject({ min: -900, max: 10 });
    expect(chartSeries([row('2026-07-06', '0'), row('2026-07-13', '1')], 'net_sales', true, 7).rows[1].gapBefore).toBe(false);
  });
});
