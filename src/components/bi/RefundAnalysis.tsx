'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BI_PANEL, BI_SELECT, BiNotice, BiPagination } from './BiPrimitives';
import { CHOICE_LABELS, decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { readBi, dataErrorMessage, saveBiFile } from '@/lib/bi/data-browser';
import { overviewQuery, overviewUrl, scopeMatches, sourcePageSchema, type Overview, type OverviewLocation, type SourcePage } from '@/lib/bi/overview-contracts';
import { refundExport, refundTime } from '@/lib/bi/refund-export';

type Navigate = (change: Partial<OverviewLocation>) => void;
type Analysis = NonNullable<SourcePage['refund_analysis']>;
const paidDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const sorts = { date: '统计日期', amount: '退款金额', cost: '冲回成本', order_id: '原订单编号' } as const;

function RefundGroups({ name, values, select }: { name: string; values: Analysis['refund_type']; select: (key: string) => void }) {
  const high = Math.max(0, ...values.rows.map((r) => Number(r.known)));
  return <section className={BI_PANEL} aria-label={name}><h3 className="mb-3 font-semibold">{name}</h3>
    {values.rows.length === 0 && <p className="text-sm text-muted-foreground">当前范围没有退款记录。</p>}
    {values.rows.map((row) => <button type="button" key={row.key} className="block w-full rounded px-2 py-2 text-left hover:bg-muted/50 focus-visible:outline-primary"
      onClick={() => select(row.key)}><span className="flex flex-wrap justify-between gap-2 text-sm"><span className="break-all">{row.name}</span>
        <span>{row.count} 笔 · {row.amount == null ? '已知 ' + decimalLabel(row.known) + ' 元，部分待折算' : decimalLabel(row.amount) + ' 元'}</span></span>
      <span className="mt-1 block h-1.5 rounded bg-muted"><i className="block h-full rounded bg-primary" style={{ width: (high ? Number(row.known) * 100 / high : 0) + '%' }} /></span></button>)}
  </section>;
}

export function RefundAnalysis({ location, dataset, workspaceId, range, navigate }: {
  location: OverviewLocation; dataset: Dataset; workspaceId: string; range: Overview['range']; navigate: Navigate;
}) {
  const [result, setResult] = useState<{ body: string; table: SourcePage }>();
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(location.refundSearch ?? '');
  const [feedback, setFeedback] = useState(''); const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const area = useRef<HTMLElement>(null); const [height, setHeight] = useState(580);
  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  const options = { kind: 'refund', query: { ...overviewQuery(location), start: range.start ?? undefined, end: range.end ?? undefined },
    sort: location.refundSort ?? 'date', descending: location.refundDescending ?? true };
  const page = location.refundPage ?? 1;
  const body = JSON.stringify({ ...scope, options: { ...options, page, refund_analysis: true, reason_page: location.reasonPage ?? 1 } });
  useEffect(() => setSearch(location.refundSearch ?? ''), [location.refundSearch]);
  useEffect(() => {
    const request = new AbortController();
    setError(''); setFeedback(''); setBusy(false);
    readBi('/api/bi/sources', sourcePageSchema, { method: 'POST', body, signal: request.signal }).then((table) => {
      if (!scopeMatches(workspaceId, dataset, table) || table.kind !== 'refund' || !table.refund_analysis || table.page !== page) throw new Error('退款明细范围已变化，请重新读取。');
      if (!request.signal.aborted) setResult({ body, table });
    }).catch((e) => { if (!request.signal.aborted) setError(dataErrorMessage(e)); });
    return () => { request.abort(); active.current?.abort(); active.current = null; };
  }, [body, workspaceId, dataset, page, retry]);
  const table = result?.body === body ? result.table : undefined;
  const analysis = table?.refund_analysis;
  useEffect(() => { if (table && area.current) setHeight(area.current.getBoundingClientRect().height); }, [table]);
  async function download() {
    if (active.current) return;
    const c = new AbortController(); active.current = c; setBusy(true); setFeedback('');
    try {
      const result = await refundExport(scope, options, c.signal);
      saveBiFile(result.file, '退款明细-' + dataset.dataset_id + '-v' + dataset.version + '.csv');
      setFeedback('已导出 ' + result.total + ' 笔退款。');
    } catch (e) { if (!c.signal.aborted) setFeedback(dataErrorMessage(e)); }
    finally { if (active.current === c) { active.current = null; setBusy(false); } }
  }
  const occurred = location.refundBasis === 'occurred';
  const cards = [
    ['已完成退款', analysis?.totals.refund_amount, '元'], ['涉及原订单', analysis?.totals.refund_order_count, '笔'],
    ['退款笔数', analysis?.totals.refund_event_count, '笔'], ['退货或取消冲回的成本', analysis?.totals.refund_cost_recovery, '元'],
  ] as const;
  return <section aria-label="退款与售后核对" ref={area} style={!table ? { minHeight: height } : undefined} className="space-y-4">
    <div className={BI_PANEL}><h3 className="font-semibold">这段时间的退款如何统计</h3><p className="my-3 text-sm text-muted-foreground">{occurred
      ? '按退款实际完成的日期统计。原订单可能早于这段时间，因此这里不计算退款金额占付款金额的比例。'
      : '按原订单的付款日期统计，包括这些订单在数据截止日前完成的退款。退款占比用所选范围的付款金额作分母。'}</p>
      {(['payment', 'occurred'] as const).map((v) => <Button className="mr-2" key={v} size="sm" variant={location.refundBasis === v ? 'secondary' : 'outline'}
        aria-pressed={location.refundBasis === v} onClick={() => navigate({ refundBasis: v })}>{v === 'payment' ? '按原付款日期' : '按退款完成日期'}</Button>)}
    </div>
    {error && <BiNotice error>{error} <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>重新读取</Button></BiNotice>}
    {!error && !table && <p role="status">正在读取退款与原订单…</p>}
    {table && analysis && <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, unit]) => <div className={BI_PANEL} key={label}>
        <h4 className="text-sm text-muted-foreground">{label}</h4><p className="mt-2 text-xl font-semibold">{decimalLabel(value)}{value != null && ' ' + unit}</p></div>)}</div>
      {!occurred && <p className="text-sm">退款金额占付款金额 {analysis.totals.refund_ratio == null ? '暂无法计算' : decimalLabel(analysis.totals.refund_ratio, true)}。本期付款金额 {decimalLabel(analysis.totals.sales_amount)} 元。</p>}
      <div className="flex flex-wrap gap-2">{location.refundType && <Button variant="outline" size="sm" onClick={() => navigate({ refundType: undefined })}>清除类型筛选 · {CHOICE_LABELS[location.refundType]}</Button>}
        {location.refundReasonId && <Button variant="outline" size="sm" onClick={() => navigate({ refundReasonId: undefined })}>清除原因筛选 · {analysis.refund_reason.rows[0]?.name ?? '所选原因'}</Button>}</div>
      <div className="grid gap-3 lg:grid-cols-2"><div><RefundGroups name="按退款原因查看" values={analysis.refund_reason} select={(refundReasonId) => navigate({ refundReasonId })} />
        {analysis.refund_reason.total > 20 && <BiPagination page={location.reasonPage ?? 1} total={analysis.refund_reason.total} label="退款原因分页" change={(reasonPage) => navigate({ reasonPage })} />}</div>
        <RefundGroups name="按退款类型查看" values={analysis.refund_type} select={(v) => navigate({ refundType: v as OverviewLocation['refundType'] })} /></div>
      <div className={BI_PANEL}><h3 className="font-semibold">已完成退款明细</h3>
        <div className="my-4 flex flex-wrap items-end gap-2"><form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); navigate({ refundSearch: search.trim() }); }}>
          <label className="text-sm">查找退款<Input value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} placeholder="退款编号、原订单、商品或原因" /></label>
          <Button size="sm" variant="outline" type="submit">查找</Button></form>
          {location.refundSearch && <Button size="sm" variant="ghost" onClick={() => navigate({ refundSearch: '' })}>清除搜索</Button>}
          <label className="text-sm">排序 <select className={BI_SELECT} value={location.refundSort ?? 'date'} onChange={(e) => navigate({ refundSort: e.target.value as OverviewLocation['refundSort'] })}>
            {Object.entries(sorts).map(([key,v]) => <option key={key} value={key}>{v}</option>)}</select></label>
          <Button size="sm" variant="outline" onClick={() => navigate({ refundDescending: !options.descending })}>{options.descending ? '降序' : '升序'}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void download(); }}>{busy ? '正在导出…' : '导出全部退款'}</Button>
        </div>{feedback && <p role="status">{feedback}</p>}
        {table.rows.map((row) => <details className="border-t border-border py-2" key={row.key}>
          <summary className="cursor-pointer text-sm"><strong>{row.source_id}</strong> · {row.store_name} · {row.listing_name} · {row.refund_type && CHOICE_LABELS[row.refund_type]} · {decimalLabel(row.amount_cny)} 元</summary>
          <dl className="my-3 grid gap-2 text-sm sm:grid-cols-2">{Object.entries({
            '退款原因': row.reason || '未填写原因', '原始订单': row.platform_order_id, '订单明细': row.line_id,
            '原单付款时间': refundTime(row.paid_at), '实际退款时间': refundTime(row.occurred_at),
            '原单明细实收': row.line_paid_amount + ' ' + row.currency, '退款原币金额': row.original_amount + ' ' + row.currency,
            '退回数量（平台单位）': row.returned_quantity, '可回收数量（平台单位）': row.recoverable_quantity,
            '未发货取消数量（平台单位）': row.cancelled_quantity, '冲回商品成本（元）': decimalLabel(row.cost_cny),
          }).map(([k,v]) => <div key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}</dl>
          {row.paid_at && row.order_id && <Link className="text-sm text-primary underline" href={overviewUrl('/bi/stores', {
            workspaceId, datasetId: dataset.dataset_id, sourceKind: 'sale', sourceOrderId: row.order_id, refundBasis: 'payment',
            start: paidDate.format(new Date(row.paid_at)),
            end: paidDate.format(new Date(row.paid_at)),
            storeId: location.storeId, channelId: location.channelId, productId: location.productId, skuId: location.skuId, listingId: location.listingId, category: location.category,
          })}>查看原单付款明细</Link>}
        </details>)}
        {!table.rows.length && <p>当前筛选的这一页没有已完成退款。</p>}
        <BiPagination page={page} total={table.total} label="已完成退款分页" change={(refundPage) => navigate({ refundPage })} />
      </div>
    </>}
  </section>;
}
