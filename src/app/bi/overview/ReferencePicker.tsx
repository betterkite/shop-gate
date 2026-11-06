'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BiNotice, BiPagination, BI_SELECT } from '@/components/bi/BiPrimitives';
import type { Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { REFERENCE_LABELS, referenceDirectorySchema, referenceOptions, referenceSelection, scopeMatches,
  type OverviewLocation, type ReferenceDirectory, type ReferenceKind } from '@/lib/bi/overview-contracts';
import type { OverviewNavigate } from './OverviewWorkspace';

export function ReferencePicker({ workspaceId, dataset, location, navigate, restoreFocus }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; navigate: OverviewNavigate; restoreFocus: (event: Event) => void;
}) {
  const [response, setResponse] = useState<{ key: string; data: ReferenceDirectory } | null>(null);
  const [problem, setProblem] = useState(''); const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(location.filterSearch);
  const content = useRef<HTMLDivElement>(null); const [height, setHeight] = useState(500);
  useEffect(() => setSearch(location.filterSearch), [location.filterSearch]);
  const kind = location.filterKind ?? 'product';
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version, options: referenceOptions(location) });
  useEffect(() => {
    const controller = new AbortController(); setProblem('');
    const expected = JSON.parse(body) as { workspace_id: string; dataset_id: string; version: number; options: { kind: ReferenceKind } };
    readBi('/api/bi/references', referenceDirectorySchema, { method: 'POST', body, signal: controller.signal }).then((data) => {
      if (!scopeMatches(expected.workspace_id, expected, data) || data.kind !== expected.options.kind) throw new Error('目录的范围或版本不一致，请刷新后重试。');
      if (!controller.signal.aborted) setResponse({ key: body, data });
    }).catch((error) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [body, retry]);
  const data = response?.key === body ? response.data : null;
  useEffect(() => { if (data && content.current) setHeight(Math.max(500, content.current.getBoundingClientRect().height)); }, [data]);
  const close = () => navigate({ filterKind: undefined });
  const restricted = kind === 'store' && location.channelId || kind === 'listing' && (location.channelId || location.storeId)
    || kind === 'sku' && (location.productId || location.category !== undefined) || kind === 'product' && location.category !== undefined;
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}><SheetContent onCloseAutoFocus={restoreFocus} className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
    <SheetHeader className="border-b border-border p-6 pr-12"><SheetTitle>选择{REFERENCE_LABELS[kind]}</SheetTitle><SheetDescription>{dataset.name} · 版本 {dataset.version}。目录包含尚无交易的对象，不受当前分析日期限制。</SheetDescription></SheetHeader>
    <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
      <label className="flex flex-wrap items-center gap-2 text-sm">选择范围<select className={BI_SELECT} aria-label="筛选目录类型" value={kind} onChange={(event) => navigate({ filterKind: event.target.value as ReferenceKind, filterSearch: '', filterPage: 1 })}>
        {Object.entries(REFERENCE_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <p className="text-xs leading-6 text-muted-foreground">{['product', 'sku', 'category'].includes(kind) ? '商品和规格来自数据集的商品目录，选择后仍会结合当前平台、店铺与日期计算经营情况。' : '店铺受已选平台限制，平台商品受已选平台和店铺限制。'}{restricted ? ' 当前目录已沿用相应上级范围；如需选择其他范围，请先关闭并清除上级筛选。' : ''}</p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); navigate({ filterSearch: search.trim(), filterPage: 1 }); }}>
        <Input aria-label="搜索筛选目录" className="min-w-0 flex-1" value={search} maxLength={200} placeholder="输入名称或编号" onChange={(event) => setSearch(event.target.value)} />
        <Button variant="outline" type="submit">搜索</Button><Button variant="ghost" type="button" onClick={() => { setSearch(''); navigate({ filterSearch: '', filterPage: 1 }); }}>清除搜索</Button>
      </form>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm">排序 <select className={BI_SELECT} aria-label="目录排序依据" value={location.filterSort} onChange={(event) => navigate({ filterSort: event.target.value as 'key' | 'name' })}><option value="name">名称</option><option value="key">编号</option></select></label>
        <Button variant="outline" size="sm" onClick={() => navigate({ filterDescending: !location.filterDescending })}>{location.filterDescending ? '倒序排列' : '正序排列'}</Button></div>
      <div ref={content} style={!data ? { minHeight: height } : undefined} aria-busy={!data && !problem}>
        {problem && <BiNotice error>{problem}<Button variant="outline" size="sm" className="ml-3" onClick={() => setRetry((value) => value + 1)}>重新读取</Button></BiNotice>}
        {!data && !problem && <p role="status" className="p-5 text-sm text-muted-foreground">正在读取完整目录…</p>}
        {data && <><ul className="divide-y divide-border">{data.rows.map((row) => <li key={row.key} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0"><strong className="block break-words text-sm font-medium">{row.name}</strong><p className="mt-1 break-all text-xs text-muted-foreground">{row.key ? `编号：${row.key}` : '商品尚未填写类目'}</p>
            <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{[row.channel_name, row.store_name, row.product_name, row.category === '' ? '未分类' : row.category, row.unit].filter(Boolean).join(' · ')}</p></div>
          <Button size="sm" variant="outline" aria-label={`选择${row.name}`} onClick={() => { try { navigate(referenceSelection(kind, row)); } catch (error) { setProblem(dataErrorMessage(error)); } }}>选择</Button>
        </li>)}</ul>{!data.rows.length && <p className="p-6 text-sm text-muted-foreground">{data.total ? '此页没有对象，请返回上一页。' : '当前目录范围没有符合条件的对象，可清除搜索或调整上级筛选。'}</p>}
          <BiPagination label="筛选目录分页" page={data.page} total={data.total} change={(filterPage) => navigate({ filterPage })} /></>}
      </div>
    </div>
  </SheetContent></Sheet>;
}
