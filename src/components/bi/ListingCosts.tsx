'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { listingCostsSchema, scopeMatches, type ListingCosts as CostResult, type OverviewLocation } from '@/lib/bi/overview-contracts';
import { BI_SELECT, BiNotice, BiPagination } from './BiPrimitives';

const levels = { base: '沿用基础成本', channel: '沿用该平台成本', store: '本店专用成本' };
const businessDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const businessTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' });

const currencyNames = new Intl.DisplayNames('zh-CN', { type: 'currency' });
function unitCostLabel(row: NonNullable<CostResult['applied']>, unit: string | null) {
  const amount = row.unit_cost.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  const currency = currencyNames.of(row.currency);
  return amount + ' ' + (currency && currency !== row.currency ? currency + '（' + row.currency + '）' : row.currency) + ' / ' + unit;
}

export function ListingCosts({ workspaceId, dataset, location, listingId, periodEnd, navigate, restoreFocus }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; listingId: string; periodEnd: string | null;
  navigate: (change: Partial<OverviewLocation>) => void; restoreFocus: (event: Event) => void;
}) {
  const day = location.mappingDate ?? periodEnd ?? businessDay.format(new Date());
  const page = location.costPage ?? 1;
  const search = location.costSearch ?? '';
  const sort = location.costSort ?? 'valid_from';
  const descending = location.costDescending ?? true;
  const [text, setText] = useState(search);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [response, setResponse] = useState<{ body: string; result: CostResult } | null>(null);
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    options: { kind: 'listing_cost', listing_id: listingId, as_of: day, page, search, sort, descending } });
  useEffect(() => setText(search), [search]);
  useEffect(() => {
    const c = new AbortController();
    setError('');
    readBi('/api/bi/references', listingCostsSchema, { method: 'POST', body, signal: c.signal }).then((result) => {
      if (!scopeMatches(workspaceId, dataset, result) || result.listing_id !== listingId || result.as_of !== day || result.page !== page
        || (result.listing && result.listing.key !== listingId)) throw new Error('商品或数据版本发生变化，请重新读取。');
      if (!c.signal.aborted) setResponse({ body, result });
    }).catch((e) => { if (!c.signal.aborted) setError(dataErrorMessage(e)); });
    return () => c.abort();
  }, [attempt, body, dataset, workspaceId, listingId, day, page]);
  const result = response?.body === body ? response.result : null;
  const item = result?.listing;
  const applied = result?.applied;
  return <Sheet open onOpenChange={(open) => { if (!open) navigate({ costListingId: undefined }); }}>
    <SheetContent className="w-full overflow-auto p-5 sm:max-w-2xl sm:p-6" onCloseAutoFocus={restoreFocus}>
      <SheetHeader><SheetTitle>店铺成本依据</SheetTitle><SheetDescription>同一规格优先使用本店成本，其次使用平台成本，最后使用基础成本。</SheetDescription></SheetHeader>
      <label className="my-4 grid max-w-64 gap-1 text-sm">查询日期（北京时间）<Input type="date" value={day}
        onChange={(e) => { if (e.target.value) navigate({ mappingDate: e.target.value }); }} /></label>
      {error && <BiNotice error>{error} <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>重新读取</Button></BiNotice>}
      {!result && !error && <p role="status">正在读取成本依据…</p>}
      {result && (!item ? <BiNotice>当前数据集中找不到这个平台商品。</BiNotice> : <>
        <h3 className="font-semibold">{item.name} · {item.store_name}</h3>
        <p className="text-sm text-muted-foreground">{item.channel_name} · 平台货号 {item.platform_sku_id}</p>
        {!item.sku_id ? <BiNotice>当天还没有对应的标准规格，无法查到这家店使用的单位成本。</BiNotice> : <>
          <section className="my-4 rounded-xl border p-4" aria-label="当天采用的单位成本">
            <p className="text-sm">{item.sku_name} · 标准规格 {item.sku_id}</p>
            <h4 className="my-1 text-lg font-semibold">{applied ? unitCostLabel(applied, item.unit) : '当天缺少可用成本'}</h4>
            {applied && <p className="text-sm">{levels[applied.level]} · 来源 {applied.source} · 编号 {applied.cost_id}</p>}
            <p className="mt-2 text-xs text-muted-foreground">按所选日期结束时生效的规则和原币显示。已付款订单保留当时的成本，可以在付款明细中核对。</p>
          </section>
          <h4 className="font-semibold">这家店可用的成本版本</h4>
          <form className="my-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); navigate({ costSearch: text.trim() }); }}>
            <label className="grid gap-1 text-sm">查找版本<Input value={text} maxLength={200} placeholder="成本编号、来源或币种" onChange={(e) => setText(e.target.value)} /></label>
            <Button type="submit" size="sm">查找</Button>
            <label className="grid gap-1 text-sm">排序<select className={BI_SELECT} value={sort}
              onChange={(e) => navigate({ costSort: e.target.value as 'valid_from' | 'key' })}><option value="valid_from">生效时间</option><option value="key">成本编号</option></select></label>
            <Button type="button" variant="outline" size="sm" onClick={() => navigate({ costDescending: !descending })}>{descending ? '降序' : '升序'}</Button>
          </form>
          <ul className="divide-y">{result.rows.map((row) => <li key={row.cost_id} className="py-3 text-sm">
            <strong>{levels[row.level]} · {unitCostLabel(row, item.unit)}</strong>
            {row.cost_id === applied?.cost_id && <span className="ml-2 text-primary">当天采用</span>}
            <p>{businessTime.format(new Date(row.valid_from))} 起生效，{row.valid_to ? '至 ' + businessTime.format(new Date(row.valid_to)) + ' 前' : '持续有效'}</p>
            <p className="break-words text-muted-foreground">{row.source} · 编号 {row.cost_id} · 登记于数据版本 {row.created_version} {row.superseded_version && `（已于第 ${row.superseded_version} 版替代）`}</p>
          </li>)}</ul>
          {!result.rows.length && <p className="text-sm">当前条件下没有成本版本。</p>}
          <BiPagination page={page} total={result.total} label="店铺成本版本分页" change={(costPage) => navigate({ costPage })} />
        </>}
        <Button className="mt-4" variant="outline" onClick={() => navigate({ listingId, sourceKind: 'sale' })}>查看所选期间付款明细</Button>
      </>)}
    </SheetContent>
  </Sheet>;
}
