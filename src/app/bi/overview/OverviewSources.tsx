'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BiNotice, BiPagination, BI_SELECT } from '@/components/bi/BiPrimitives';
import { decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { DIMENSION_LABELS, QUALITY_LABELS, ledgerTableSchema, overviewQuery, scopeMatches,
  type LedgerTable, type OverviewLocation, type Overview } from '@/lib/bi/overview-contracts';
import type { OverviewNavigate } from './OverviewWorkspace';

export function OverviewSources({ workspaceId, dataset, location, range, navigate, restoreFocus }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; range: Overview['range']; navigate: OverviewNavigate; restoreFocus: (event: Event) => void;
}) {
  const [response, setResponse] = useState<{ key: string; data: LedgerTable } | null>(null);
  const [problem, setProblem] = useState(''); const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(location.detailSearch);
  const content = useRef<HTMLDivElement>(null); const [height, setHeight] = useState(520);
  useEffect(() => setSearch(location.detailSearch), [location.detailSearch]);
  // A detail may narrow the page scope, never replace a narrower global selection.
  const channel = location.channelId ?? location.detailChannelId;
  const store = location.storeId ?? location.detailStoreId;
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    query: { ...overviewQuery(location), ...(range.start ? { start: range.start } : {}), ...(range.end ? { end: range.end } : {}),
      dimension: location.detailDimension, channel_ids: channel ? [channel] : [], store_ids: store ? [store] : [],
      search: location.detailSearch, sort: location.detailSort, descending: location.detailDescending, page: location.detailPage, page_size: 20 } });
  useEffect(() => {
    const controller = new AbortController(); setProblem('');
    const expected = JSON.parse(body) as { workspace_id: string; dataset_id: string; version: number };
    readBi('/api/bi/query', ledgerTableSchema, { method: 'POST', body, signal: controller.signal }).then((data) => {
      if (!scopeMatches(expected.workspace_id, expected, data)) throw new Error('来源明细的范围或版本不一致，请刷新。');
      if (!controller.signal.aborted) setResponse({ key: body, data });
    }).catch((error) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [body, retry]);
  const data = response?.key === body ? response.data : null;
  useEffect(() => { if (data && content.current) setHeight(Math.max(520, content.current.getBoundingClientRect().height)); }, [data]);
  const close = () => navigate({ detailDimension: undefined, detailChannelId: undefined, detailStoreId: undefined, detailPage: 1, detailSearch: '' });
  const dimension = location.detailDimension ?? 'line';
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}><SheetContent onCloseAutoFocus={restoreFocus} className="flex w-full flex-col gap-0 p-0 sm:max-w-4xl">
    <SheetHeader className="border-b border-border p-6 pr-12"><SheetTitle>查看{DIMENSION_LABELS[dimension]}</SheetTitle><SheetDescription>{range.start ?? '尚无日期'} 至 {range.end ?? '尚无日期'} · {dataset.name} · 版本 {dataset.version}。沿用当前页面范围，金额以元计。</SheetDescription></SheetHeader>
    <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm">查看方式 <select className={BI_SELECT} value={dimension} onChange={(e) => navigate({ detailDimension: e.target.value as typeof dimension })}>
        {Object.entries(DIMENSION_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label className="text-sm">排序 <select className={BI_SELECT} value={location.detailSort} onChange={(e) => navigate({ detailSort: e.target.value as OverviewLocation['detailSort'] })}>
          <option value="net_sales">净销售额</option><option value="accounted_contribution">已核算经营贡献</option><option value="order_count">付款订单数</option><option value="key">编号 / 日期</option></select></label>
        <Button variant="outline" size="sm" onClick={() => navigate({ detailDescending: !location.detailDescending })}>{location.detailDescending ? '从高到低' : '从低到高'}</Button>
      </div>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); navigate({ detailSearch: search.trim(), detailPage: 1 }); }}>
        <Input value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} aria-label="搜索来源记录" placeholder="搜索名称或记录编号" /><Button type="submit" variant="outline">搜索</Button></form>
      <p className="text-xs leading-6 text-muted-foreground">搜索会缩小参与汇总的来源记录。未归属的费用独立显示；商品明细之和不一定包含这些费用。</p>
      {problem && <BiNotice error>{problem}<Button variant="outline" size="sm" onClick={() => setRetry((v) => v + 1)}>重试</Button></BiNotice>}
      <div ref={content} aria-busy={!data && !problem} className="overflow-x-auto" style={{ minHeight: height }}>
        {!data && !problem && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取所选范围的明细…</p>}
        {data && <><div className="mb-4 rounded-xl bg-muted/40 p-3 text-sm">全部筛选结果的净销售额：{data.total ? decimalLabel(data.summary.metrics.net_sales) : '没有相关记录'}；已核算经营贡献：{data.total ? decimalLabel(data.summary.metrics.accounted_contribution) : '没有相关记录'}。</div>
          <table className="w-full min-w-[640px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-3">{DIMENSION_LABELS[dimension]}</th><th className="p-3 text-right">净销售额</th><th className="p-3 text-right">已核算经营贡献</th><th className="p-3 text-right">付款订单数</th><th className="p-3">数据情况 / 操作</th></tr></thead>
            <tbody>{data.rows.map((row) => <tr key={row.key} className="border-t border-border"><th className="max-w-60 break-words p-3 font-medium">{row.name}<span className="mt-1 block break-all text-xs font-normal text-muted-foreground">{row.key}</span></th>
              <td className="p-3 text-right tabular-nums">{decimalLabel(row.metrics.net_sales)}</td><td className="p-3 text-right tabular-nums">{decimalLabel(row.metrics.accounted_contribution)}</td><td className="p-3 text-right tabular-nums">{decimalLabel(row.metrics.order_count)}</td>
              <td className="max-w-64 p-3 text-xs leading-6 text-muted-foreground">{Object.entries(QUALITY_LABELS).filter(([key]) => Number(row.quality[key]) > 0).map(([key, label]) => <p key={key}>{label}：{String(row.quality[key])}</p>)}
                {row.key !== '__unattributed__' && ['channel', 'store', 'product', 'sku', 'listing'].includes(dimension) && <Button variant="outline" size="sm" onClick={() => {
                  const fields: Partial<Record<typeof dimension, keyof OverviewLocation>> = { channel: 'channelId', store: 'storeId', product: 'productId', sku: 'skuId', listing: 'listingId' };
                  const field = fields[dimension]; if (!field) return;
                  navigate({ [field]: row.key, ...(dimension === 'store' && channel ? { channelId: channel } : {}), detailDimension: undefined, detailChannelId: undefined, detailStoreId: undefined, detailSearch: '', detailPage: 1 });
                }}>用此范围查看总览</Button>}</td></tr>)}</tbody></table>
          {!data.rows.length && <p className="p-6 text-sm text-muted-foreground">{data.total ? '此页没有记录，请返回上一页。' : '当前筛选范围没有相关记录。'}</p>}
          <BiPagination page={data.page} total={data.total} label="来源明细分页" change={(detailPage) => navigate({ detailPage })} />
        </>}
      </div>
    </div>
  </SheetContent></Sheet>;
}
