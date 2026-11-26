'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CostDraft } from '@/lib/bi/agent/result-contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { BI_SELECT, BiNotice, BiPagination } from './BiPrimitives';

const previous = z
  .object({ unit_cost: z.string(), currency: z.string(), level: z.string() })
  .nullable();
const item = z.object({
  sku_id: z.string(),
  name: z.string(),
  unit: z.string(),
  unit_cost: z.string(),
  previous,
  changed: z.boolean(),
});
const amounts = z.object({
  contribution_profit: z.string().nullable(),
  accounted_contribution: z.string().nullable(),
  coverage_ratio: z.string().nullable(),
});
const preview = z.object({
  workspace_id: z.string(),
  dataset_id: z.string(),
  version: z.number(),
  preview_id: z.string(),
  expires_at: z.string(),
  impact: z.object({
    items: z.array(item),
    historical_paid_lines: z.number(),
    before: amounts,
    after: amounts,
  }),
});
const saved = z.object({
  workspace_id: z.string(),
  dataset_id: z.string(),
  version: z.number(),
  accounting_revision: z.number(),
  changed: z.boolean(),
});

export function CostChangeForm({
  scope,
  selected,
  store,
  channel,
  onSaved, draft,
}: {
  scope: { workspace_id: string; dataset_id: string; version: number };
  selected: string[];
  store?: string;
  channel?: string;
  onSaved: () => void; draft?: Extract<CostDraft, {action:"adjust"}>;
}) {
  const [level, setLevel] = useState<'base' | 'channel' | 'store'>(draft?.level ?? 'base');
  const [method, setMethod] = useState<string>(draft?.method ?? 'fixed'),
    [value, setValue] = useState(draft?.value ?? ''),
    [currency, setCurrency] = useState(draft?.currency ?? 'CNY');
  const [effective, setEffective] = useState(draft?.effective_local ?? ''),
    [note, setNote] = useState(''),
    [allowZero, setAllowZero] = useState(false);
  const [review, setReview] = useState<{
    data: z.infer<typeof preview>;
    key: string;
    request: string;
  }>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1);
  const lock = useRef<AbortController | null>(null);
  useEffect(() => () => lock.current?.abort(), []);
  const change = {
    sku_ids: selected,
    level,
    scope_id: level === 'base' ? null : level === 'channel' ? channel : store,
    method,
    value,
    currency,
    effective_at: effective ? effective + ':00+08:00' : '',
    note,
    allow_zero: allowZero,
  };
  const body = JSON.stringify({ ...scope, change });
  const active = review?.request === body ? review : undefined;
  async function submit(confirm: boolean) {
    if (lock.current || (confirm && !active)) return;
    const c = new AbortController();
    lock.current = c;
    setBusy(true);
    setError('');
    try {
      if (confirm && active) {
        const r = await readBi('/api/bi/costs/confirm', saved, {
          method: 'POST',
          signal: c.signal,
          body: JSON.stringify({
            ...scope,
            preview_id: active.data.preview_id,
            idempotency_key: active.key,
            confirmed_by_user: true,
          }),
        });
        if (
          r.workspace_id !== scope.workspace_id ||
          r.dataset_id !== scope.dataset_id ||
          r.accounting_revision !== r.version ||
          r.version !== scope.version + Number(r.changed)
        )
          throw new Error('保存结果与所选数据集版本不一致。');
        if (!c.signal.aborted) {
          setReview(undefined);
          onSaved();
        }
      } else {
        const data = await readBi('/api/bi/costs/preview', preview, {
          method: 'POST',
          signal: c.signal,
          body,
        });
        if (
          data.workspace_id !== scope.workspace_id ||
          data.dataset_id !== scope.dataset_id ||
          data.version !== scope.version ||
          data.impact.items.length !== selected.length ||
          new Set(data.impact.items.map(r => r.sku_id)).size !== selected.length ||
          data.impact.items.some(r => !selected.includes(r.sku_id))
        )
          throw new Error('成本预览的规格或版本已变化。');
        if (!c.signal.aborted) {
          setReview({ request: body, data, key: crypto.randomUUID() });
          setPage(1);
        }
      }
    } catch (e) {
      if (!c.signal.aborted) setError(dataErrorMessage(e));
    } finally {
      if (!c.signal.aborted) {
        lock.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label="维护所选规格成本" className="my-3 rounded-xl border bg-card p-4">
      <h4 className="font-semibold">调整已选的 {selected.length} 个规格</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="mt-3 grid gap-3 sm:grid-cols-2"
      >
        <fieldset disabled={busy} className="contents">
          <label className="grid gap-1 text-sm">
            成本适用范围
            <select
              className={BI_SELECT}
              value={level}
              onChange={(e) => setLevel(e.target.value as typeof level)}
            >
              <option value="base">所有店铺共用的基础成本</option>
              {channel && <option value="channel">当前平台</option>}
              {store && <option value="store">当前店铺</option>}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            调整方式
            <select className={BI_SELECT} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="fixed">设为固定金额</option>
              <option value="amount">在原成本上增加或减少金额</option>
              <option value="percent">在原成本上增加或减少百分比</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {method === 'percent'
              ? '变化百分比（减少填负数）'
              : method === 'amount'
                ? '增减金额（减少填负数）'
                : '每标准单位的新成本'}
            <Input
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              maxLength={20}
            />
          </label>
          <label className="grid gap-1 text-sm">
            成本币种
            <Input
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              maxLength={3}
            />
          </label>
          <label className="grid gap-1 text-sm">
            生效时间（北京时间）
            <Input
              required
              type="datetime-local"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            调整原因或来源
            <Input required value={note} onChange={(e) => setNote(e.target.value)} maxLength={240} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowZero}
              onChange={(e) => setAllowZero(e.target.checked)}
            />
            已核对业务原因，允许调整为零元
          </label>
          <Button disabled={busy || !selected.length} type="submit" variant="outline">
            预览成本调整
          </Button>
        </fieldset>
      </form>
      {error && <BiNotice error>{error}</BiNotice>}
      {active && (
        <div className="mt-3 grid gap-2 text-sm" aria-label="成本调整预览">
          <h5 className="font-semibold">保存前核对</h5>
          {active.data.impact.items.slice((page - 1) * 20, page * 20).map((r) => (
            <p key={r.sku_id}>
              {r.name}（{r.sku_id}）　
              {r.previous ? r.previous.unit_cost + ' ' + r.previous.currency : '尚无成本'} →{' '}
              {r.unit_cost} {currency} / {r.unit}
              {!r.changed && '（沿用原规则）'}
            </p>
          ))}
          <BiPagination
            page={page}
            total={active.data.impact.items.length}
            label="成本调整预览分页"
            change={setPage}
          />
          <p>
            有 {active.data.impact.historical_paid_lines}{' '}
            条历史付款明细落在这些规则的生效范围内。仅保存成本版本时，原订单仍沿用付款时的金额。下表展示另外确认历史重算后，全库利润可能发生的变化。
          </p>
          <table className="w-full text-left">
            <caption className="sr-only">历史重算影响</caption>
            <thead>
              <tr>
                <th>全库指标</th>
                <th>当前</th>
                <th>重算后</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['contribution_profit', '完整经营贡献（元）'],
                  ['accounted_contribution', '已有依据的贡献（元）'],
                  ['coverage_ratio', '成交金额核算覆盖率'],
                ] as const
              ).map(([key, label]) => (
                <tr key={key}>
                  <th>{label}</th>
                  {[active.data.impact.before, active.data.impact.after].map((v, i) => (
                    <td key={i}>
                      {v[key] === null ? '待核算' : decimalLabel(v[key], key === 'coverage_ratio')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Button disabled={busy} onClick={() => void submit(true)}>
            确认保存成本版本
          </Button>
        </div>
      )}
    </section>
  );
}
