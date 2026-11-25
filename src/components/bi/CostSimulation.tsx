'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { BiNotice } from './BiPrimitives';

const numeric = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .nullable();
const measures = z.object({
  product_cost: numeric,
  refund_cost_recovery: numeric,
  contribution_profit: numeric,
  accounted_contribution: numeric,
  contribution_margin: numeric,
  coverage_ratio: numeric,
});
const schema = z.object({
  workspace_id: z.string(),
  dataset_id: z.string(),
  version: z.number(),
  accounting_revision: z.number(),
  sku_id: z.string(),
  unit_cost_cny: numeric,
  unit: z.string(),
  range: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  affected_orders: z.number().int().nonnegative(),
  before: measures,
  after: measures,
  profit_difference_cny: numeric,
});
const labels = [
  ['product_cost', '商品成本净额（元）'],
  ['refund_cost_recovery', '退款冲回成本（元）'],
  ['contribution_profit', '完整经营贡献（元）'],
  ['accounted_contribution', '已有依据的贡献（元）'],
  ['contribution_margin', '经营贡献利润率'],
  ['coverage_ratio', '成交金额核算覆盖率'],
] as const;

export function CostSimulation({
  scope,
  sku,
  unit,
  query,
}: {
  scope: { workspace_id: string; dataset_id: string; version: number };
  sku: string;
  unit: string;
  query: object;
}) {
  const [price, setPrice] = useState('');
  const [result, setResult] = useState<z.infer<typeof schema>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function calculate() {
    if (pending.current) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const r = await readBi('/api/bi/costs/simulate', schema, {
        method: 'POST',
        signal: c.signal,
        body: JSON.stringify({ ...scope, query, sku_id: sku, unit_cost: price.trim() }),
      });
      if (
        r.workspace_id !== scope.workspace_id ||
        r.dataset_id !== scope.dataset_id ||
        r.version !== scope.version ||
        r.accounting_revision !== scope.version ||
        r.sku_id !== sku
      )
        throw new Error('数据范围已变化，请重新试算。');
      if (!c.signal.aborted) setResult(r);
    } catch (e) {
      if (!c.signal.aborted) setError(dataErrorMessage(e));
    } finally {
      if (!c.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label="商品成本试算" className="mt-4 space-y-3 rounded-lg border p-3">
      <h4 className="font-semibold">试算这个规格的成本</h4>
      <p className="text-sm">
        输入每{unit}
        的假设成本，查看当前经营期间和店铺范围内的订单会产生多少利润。费用沿用账本记录，试算结果仅供比较。
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void calculate();
        }}
      >
        <label className="grid gap-1 text-sm">
          假设单位成本（人民币元 / {unit}）
          <Input
            required
            disabled={busy}
            inputMode="decimal"
            pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?"
            maxLength={17}
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setResult(undefined);
              setError('');
            }}
          />
        </label>
        <Button type="submit" disabled={busy || !price.trim()}>
          {busy ? '正在计算…' : '计算试算结果'}
        </Button>
      </form>
      {error && <BiNotice error>{error}</BiNotice>}
      {result && (
        <div role="status">
          <p className="text-sm">
            {result.range.start} 至 {result.range.end}，涉及 {result.affected_orders} 笔订单。
            {result.affected_orders === 0
              ? '当前范围没有这个规格的付款或退款。'
              : result.profit_difference_cny === null
                ? '还有缺少依据的记录，完整利润差额暂时无法计算。'
                : '经营贡献利润变化 ' + decimalLabel(result.profit_difference_cny) + ' 元。'}
          </p>
          <table className="mt-2 w-full text-left text-sm">
            <caption className="sr-only">原账本与试算结果</caption>
            <thead>
              <tr>
                <th>比较项</th>
                <th>原账本</th>
                <th>试算后</th>
              </tr>
            </thead>
            <tbody>
              {labels.map(([key, label]) => (
                <tr key={key}>
                  <th className="py-1 font-normal">{label}</th>
                  {[result.before, result.after].map((v, i) => (
                    <td key={i}>
                      {v[key] === null
                        ? '待核算'
                        : decimalLabel(
                            v[key],
                            key === 'contribution_margin' || key === 'coverage_ratio',
                          )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
