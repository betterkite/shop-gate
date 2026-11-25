'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BiNotice, BiPagination, BI_SELECT } from '@/components/bi/BiPrimitives';
import { decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { QUALITY_LABELS, qualityEvidenceSchema, overviewQuery, scopeMatches,
  type QualityEvidence as Evidence, type OverviewLocation, type Overview } from '@/lib/bi/overview-contracts';
import type { OverviewNavigate } from './OverviewWorkspace';

export function QualityEvidence({ workspaceId, dataset, location, overview, navigate, restoreFocus }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; overview: Overview;
  navigate: OverviewNavigate; restoreFocus: (event: Event) => void;
}) {
  const key = location.qualityKey!;
  const [response, setResponse] = useState<{ key: string; data: Evidence } | null>(null);
  const [problem, setProblem] = useState(''); const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState(location.evidenceSearch);
  const content = useRef<HTMLDivElement>(null); const [height, setHeight] = useState(520);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [location.evidenceRecord, key]);
  useEffect(() => setSearch(location.evidenceSearch), [location.evidenceSearch]);
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    options: { quality_key: key, query: { ...overviewQuery(location), ...(overview.range.start ? { start: overview.range.start } : {}),
      ...(overview.range.end ? { end: overview.range.end } : {}) }, search: location.evidenceSearch,
    sort: location.evidenceSort, descending: location.evidenceDescending, page: location.evidencePage,
    ...(location.evidenceRecord ? { record_key: location.evidenceRecord } : {}), event_page: location.evidenceEventPage } });
  const expectedCount = Number(overview.summary.quality[key]);
  useEffect(() => {
    const controller = new AbortController(); setProblem('');
    const expected = JSON.parse(body) as { workspace_id: string; dataset_id: string; version: number; options: { quality_key: string } };
    readBi('/api/bi/evidence', qualityEvidenceSchema, { method: 'POST', body, signal: controller.signal }).then((data) => {
      if (!scopeMatches(expected.workspace_id, expected, data) || data.quality_key !== expected.options.quality_key
          || data.scope_total !== expectedCount) throw new Error('证据与当前提醒的范围或版本不一致，请刷新后查看。');
      if (!controller.signal.aborted) setResponse({ key: body, data });
    }).catch((error) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [body, expectedCount, retry]);
  const data = response?.key === body ? response.data : null;
  useEffect(() => { if (data && content.current) setHeight(Math.max(520, content.current.getBoundingClientRect().height)); }, [data]);
  return <Sheet open onOpenChange={(open) => { if (!open) navigate({ qualityKey: undefined, evidenceRecord: undefined }); }}>
    <SheetContent onCloseAutoFocus={restoreFocus} className="flex w-full flex-col gap-0 p-0 sm:max-w-4xl">
      <SheetHeader className="border-b border-border p-6 pr-12"><SheetTitle>{QUALITY_LABELS[key]}</SheetTitle><SheetDescription>
        {overview.range.start ?? '无日期'} 至 {overview.range.end ?? '无日期'} · {dataset.name} · 版本 {dataset.version}。沿用当前页面的全部筛选。</SheetDescription></SheetHeader>
      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        <p className="text-sm leading-6 text-muted-foreground">{key.includes('expenses') ? '每笔费用只计一项；尚未确定归属时，原始费用不能当作所选商品承担的金额。' : '每条订单明细只计一项；同一明细的付款和多次退款可展开逐笔查看。'}</p>
        <div className="flex flex-wrap items-center gap-3"><label className="text-sm">排序 <select className={BI_SELECT} value={location.evidenceSort} onChange={(event) => navigate({ evidenceSort: event.target.value as OverviewLocation['evidenceSort'] })}>
          <option value="key">来源编号</option><option value="name">名称</option><option value="date">统计日期</option></select></label>
          <Button size="sm" variant="outline" onClick={() => navigate({ evidenceDescending: !location.evidenceDescending })}>{location.evidenceDescending ? '从后到前' : '从前到后'}</Button></div>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); navigate({ evidenceSearch: search.trim() }); }}>
          <Input value={search} maxLength={200} aria-label="搜索提醒来源" placeholder="搜索名称、店铺、订单或来源编号" onChange={(event) => setSearch(event.target.value)} /><Button variant="outline" type="submit">搜索</Button></form>
        {problem && <BiNotice error>{problem}<Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>重试</Button></BiNotice>}
        <div ref={content} aria-busy={!data && !problem} style={{ minHeight: height }}>
          {!data && !problem && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取触发提醒的记录…</p>}
          {data && <><p className="mb-4 text-sm">当前范围共 {data.scope_total} 项待核算记录，搜索后 {data.total} 项。</p>
            {location.evidenceRecord ? <><Button size="sm" variant="outline" className="mb-4" onClick={() => navigate({ evidenceRecord: undefined })}>返回提醒记录列表</Button>
              <EvidenceEvents events={data.events} /><BiPagination label="相关事件分页" page={data.events.page} total={data.events.total} change={(evidenceEventPage) => navigate({ evidenceEventPage })} /></>
              : <><div className="overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead><tr><th className="p-3">来源 / 店铺</th><th className="p-3">待补充的信息</th><th className="p-3">相关记录</th></tr></thead>
                <tbody>{data.rows.map((row) => <tr key={row.key} className="border-t border-border"><th className="max-w-56 break-words p-3 font-medium">{row.name}<span className="block text-xs font-normal text-muted-foreground">{row.store_name ?? '未指定店铺'} · {row.date}</span><span className="block break-all text-xs font-normal">{row.kind === 'expense' ? '费用' : '订单明细'}：{row.key}</span>{row.order_id && <span className="block break-all text-xs font-normal">订单：{row.order_id}</span>}</th>
                  <td className="max-w-72 p-3 text-sm leading-6 text-muted-foreground">{row.reasons.map((reason) => <p key={reason}>{reason}</p>)}</td><td className="p-3"><Button size="sm" variant="outline" onClick={() => navigate({ evidenceRecord: row.key })}>查看 {row.event_count} 条记录</Button></td></tr>)}</tbody></table></div>
                {!data.rows.length && <p className="p-4 text-sm text-muted-foreground">{data.total ? '此页没有记录，请返回上一页。' : '当前搜索没有匹配的待核算记录。'}</p>}
                <BiPagination label="提醒来源分页" page={data.page} total={data.total} change={(evidencePage) => navigate({ evidencePage })} /></>}
          </>}
        </div>
      </div>
    </SheetContent>
  </Sheet>;
}

export function EvidenceEvents({ events }: { events: Evidence['events'] }) {
  return <div className="space-y-3"><p className="text-sm">来源：{events.record_key} · 共 {events.total} 条相关记录。原币金额保留原始币种，人民币金额来自同版本核算。</p>
    {!events.total && <p className="text-sm text-muted-foreground">该记录不在当前提醒及搜索范围内，请返回列表重新选择。</p>}
    {events.rows.map((event) => <article key={event.key} className="space-y-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
      <h4 className="break-all font-medium">{{ sale: '付款记录', refund: '退款记录', expense: '费用记录' }[event.kind]}：{event.source_id}</h4>
      <p className="text-muted-foreground">统计日期：{event.date}；{event.store_name ?? '未指定店铺'}{event.listing_name ? ` · ${event.listing_name}` : ''}</p>
      {event.order_id && <p className="break-all">原订单：{event.order_id}；订单明细：{event.line_id}</p>}
      {event.paid_at && <p>原付款时间（北京时间）：{sourceTime(event.paid_at)}</p>}{event.occurred_at && <p>发生时间（北京时间）：{sourceTime(event.occurred_at)}</p>}
      <p>原币{event.kind === 'expense' ? '整笔费用' : '金额'}：{decimalLabel(event.original_amount)} {event.currency}</p>
      {event.kind === 'expense' && <p>整笔费用折合人民币：{decimalLabel(event.source_amount_cny)} 元；不等于当前商品应承担金额。</p>}
      <p>{event.kind === 'expense' ? '本范围已分摊费用' : event.kind === 'refund' ? '退款金额' : '付款金额'}：{decimalLabel(event.amount_cny)} 元</p>
      {event.kind !== 'expense' && <p>{event.kind === 'refund' ? '退货冲回成本' : '商品成本'}：{decimalLabel(event.cost_cny)} 元</p>}
      <p className="leading-6 text-muted-foreground">{event.reason}</p>
    </article>)}
  </div>;
}

function sourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date) : '时间记录无效';
}
