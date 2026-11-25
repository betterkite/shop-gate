'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { BiNotice, BiPagination } from './BiPrimitives';

const base = z.object({ workspace_id: z.string(), dataset_id: z.string(), version: z.number() });
type Scope = z.infer<typeof base>;
const recalc = base.extend({
  preview_id: z.string(),
  impact: z.object({
    candidate_lines: z.number(),
    changed_lines: z.number(),
    changed_expenses: z.number(),
    known_cost_before_cny: z.string(),
    known_cost_after_cny: z.string(),
  }),
});
const committed = base.extend({ accounting_revision: z.number(), changed: z.boolean() });
const op = z.object({
  preview_id: z.string(),
  kind: z.enum(['costs', 'recalculate']),
  actor_id: z.string(),
  committed_version: z.number(),
  consumed_at: z.string(),
  note: z.string().nullable(),
  currency: z.string().nullable(),
  lines: z.string().nullable(),
  changed: z.boolean(),
});
const item = z.object({
  key: z.string(),
  name: z.string().optional(),
  after: z.string().optional(),
  before: z.object({ unit_cost: z.string(), currency: z.string() }).nullable().optional(),
});
const list = base.extend({
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.literal(20),
  preview_id: z.string().nullable(),
  rows: z.array(z.union([op, item])),
});
const same = (a: Scope, b: Scope) =>
  a.workspace_id === b.workspace_id && a.dataset_id === b.dataset_id && a.version === b.version;

export function RecalculateCosts({
  scope,
  query,
  selected,
  onSaved, initialMissing,
}: {
  scope: Scope;
  query: object;
  selected: string[];
  onSaved: () => void; initialMissing?: boolean;
}) {
  const [only, setOnly] = useState(initialMissing ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [review, setReview] = useState<{ data: z.infer<typeof recalc>; id: string; request: string }>();
  const lock = useRef<AbortController | null>(null);
  useEffect(() => () => lock.current?.abort(), []);
  const request = JSON.stringify({
    ...scope,
    change: { query, sku_ids: selected, only_missing: only },
  });
  const active = review?.request === request ? review : undefined;
  async function run(confirm: boolean) {
    if (lock.current || (confirm && !active)) return;
    const ctrl = new AbortController();
    lock.current = ctrl;
    setBusy(true);
    setError('');
    try {
      if (confirm && active) {
        const v = await readBi('/api/bi/recalculations/confirm', committed, {
          method: 'POST',
          signal: ctrl.signal,
          body: JSON.stringify({
            ...scope,
            preview_id: active.data.preview_id,
            idempotency_key: active.id,
            confirmed_by_user: true,
          }),
        });
        if (
          !same({ ...scope, version: scope.version + Number(v.changed) }, v) ||
          v.accounting_revision !== v.version
        )
          throw new Error('重算版本已变化。');
        if (!ctrl.signal.aborted) {
          setReview(undefined);
          onSaved();
        }
      } else {
        const v = await readBi('/api/bi/recalculations/preview', recalc, {
          method: 'POST',
          signal: ctrl.signal,
          body: request,
        });
        if (!same(scope, v)) throw new Error('请刷新后重新预览。');
        if (!ctrl.signal.aborted) setReview({ data: v, id: crypto.randomUUID(), request });
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(dataErrorMessage(e));
    } finally {
      if (!ctrl.signal.aborted) {
        lock.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <details open={initialMissing === undefined ? undefined : true} className="my-4 rounded-xl border p-3">
      <summary className="cursor-pointer font-semibold">重新核算历史付款</summary>
      <p className="my-2 text-sm">
        按当前付款期间和店铺条件查找
        {selected.length ? '已选 ' + selected.length + ' 个规格' : '当前筛选范围内全部规格'}
        的历史订单。先预览，核对后可以写入新的核算版本。
      </p>
      <label className="mr-3 text-sm">
        <input
          checked={only}
          type="checkbox"
          disabled={busy}
          onChange={(e) => {
            setOnly(e.target.checked);
            setReview(undefined);
          }}
        />{' '}
        仅重算原先缺少依据的明细
      </label>
      <Button variant="outline" disabled={busy} onClick={() => void run(false)}>
        预览历史重算
      </Button>
      {error && <BiNotice error>{error}</BiNotice>}
      {active && (
        <div className="mt-2 grid gap-2 text-sm">
          <p>
            选中 {active.data.impact.candidate_lines} 条付款明细，其中{' '}
            {active.data.impact.changed_lines} 条需要更新。全库已有依据的原付款成本将从{' '}
            {active.data.impact.known_cost_before_cny} 元变为 {active.data.impact.known_cost_after_cny}{' '}
            元。
          </p>
          <Button disabled={busy} onClick={() => void run(true)}>
            确认重新核算历史订单
          </Button>
        </div>
      )}
    </details>
  );
}

export function CostOperations({
  scope,
  previewId,
  page,
  open,
  move,
}: {
  scope: Scope;
  previewId?: string;
  page: number;
  open: (id?: string) => void;
  move: (page: number) => void;
}) {
  const [response, setResponse] = useState<{ key: string; data: z.infer<typeof list> }>(),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const body = JSON.stringify({ ...scope, page, preview_id: previewId ?? null });
  useEffect(() => {
    const c = new AbortController();
    setError('');
    readBi('/api/bi/costs/operations', list, { method: 'POST', body, signal: c.signal })
      .then((data) => {
        if (
          data.workspace_id !== scope.workspace_id ||
          data.dataset_id !== scope.dataset_id ||
          data.version !== scope.version ||
          data.page !== page ||
          data.preview_id !== (previewId ?? null)
        )
          throw new Error('维护记录范围已变化。');
        if (!c.signal.aborted) setResponse({ key: body, data });
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(dataErrorMessage(e));
      });
    return () => c.abort();
  }, [scope.workspace_id, scope.dataset_id, scope.version, page, previewId, body, retry]);
  const data = response?.key === body ? response.data : undefined;
  return (
    <section aria-label="成本维护记录" className="mt-4 rounded-xl border p-3">
      <h4 className="font-semibold">{previewId ? '这次维护涉及的规格或明细' : '成本维护记录'}</h4>
      {previewId && (
        <Button size="sm" variant="ghost" onClick={() => open()}>
          返回维护记录
        </Button>
      )}
      {error ? (
        <BiNotice error>
          {error}{' '}
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </BiNotice>
      ) : !data ? (
        <p role="status">正在读取维护记录…</p>
      ) : (
        <>
          {data.rows.map((r) =>
            'preview_id' in r ? (
              <div key={r.preview_id} className="border-b py-2 text-sm">
                <strong>{r.kind === 'costs' ? '保存成本版本' : '重新核算历史订单'}</strong> ·{' '}
                {new Date(r.consumed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                （北京时间）· 数据版本 {r.committed_version}
                <p>
                  操作人 {r.actor_id}　{r.note ?? ''}　涉及付款明细 {r.lines ?? '待核对'} 条
                </p>
                <Button size="sm" variant="outline" onClick={() => open(r.preview_id)}>
                  查看涉及的对象
                </Button>
              </div>
            ) : (
              <p className="border-b py-2 text-sm" key={r.key}>
                {r.name ?? '付款明细'} · {r.key}
                {r.after &&
                  '　原成本 ' +
                    (r.before ? r.before.unit_cost + ' ' + r.before.currency : '未设置') +
                    '，调整后 ' +
                    r.after}
              </p>
            ),
          )}
          {!data.total && <p className="my-2 text-sm">当前数据集还没有可展示的维护记录。</p>}
          <BiPagination page={page} total={data.total} label="成本维护记录分页" change={move} />
        </>
      )}
    </section>
  );
}
