'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BiNotice, BiPagination, BI_SELECT } from './BiPrimitives';
import { CHOICE_LABELS, decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { overviewQuery, POSTING_KINDS, scopeMatches, sourcePageSchema,
  type Overview, type OverviewLocation, type PostingKind, type SourcePage } from '@/lib/bi/overview-contracts';

const MISSING_AT_PAYMENT = { missing_mapping: '没有对应标准规格', missing_cost: '缺少规格成本', missing_fx: '缺少换算汇率' } as const;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
function localTime(iso: string | null) {
  return iso ? timeFormat.format(new Date(iso)) : '未记录';
}

export function SourceRecords({ dataset, workspaceId, location, range, navigate, restoreFocus }: {
  dataset: Dataset; workspaceId: string; location: OverviewLocation; range: Overview['range'];
  navigate: (change: Partial<OverviewLocation>) => void; restoreFocus: (event: Event) => void;
}) {
  const kind = location.sourceKind ?? 'sale';
  const page = location.sourcePage ?? 1;
  const activeSearch = location.sourceSearch ?? '';
  const [search, setSearch] = useState(activeSearch);
  const [response, setResponse] = useState<{ body: string; table: SourcePage } | null>(null);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320);
  useEffect(() => setSearch(activeSearch), [activeSearch]);
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    options: { kind, page, search: activeSearch, descending: location.sourceDescending ?? true,
      order_id: location.sourceOrderId, query: { ...overviewQuery(location),
        ...(range.start && { start: range.start }), ...(range.end && { end: range.end }) } } });
  useEffect(() => {
    const controller = new AbortController();
    setProblem('');
    readBi('/api/bi/sources', sourcePageSchema, { method: 'POST', body, signal: controller.signal }).then((table) => {
      if (!scopeMatches(workspaceId, dataset, table) || table.kind !== kind || table.page !== page) {
        throw new Error('当前明细的范围发生变化，请重新读取。');
      }
      if (!controller.signal.aborted) setResponse({ body, table });
    }).catch((e) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(e)); });
    return () => controller.abort();
  }, [body, dataset, workspaceId, kind, page, retry]);
  const data = response?.body === body ? response.table : null;
  useEffect(() => { if (area.current && data) setHeight(area.current.getBoundingClientRect().height); }, [data]);
  const close = () => navigate({ sourceKind: undefined, sourceOrderId: undefined, sourceSearch: '', sourcePage: 1, sourceDescending: true });
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}>
    <SheetContent onCloseAutoFocus={restoreFocus} className="flex w-full flex-col p-0 sm:max-w-5xl">
      <SheetHeader className="border-b border-border p-5 pr-12">
        <SheetTitle>查看付款、退款和费用</SheetTitle>
        <SheetDescription>{dataset.name} · 版本 {dataset.version} · {range.start ?? '无日期'} 至 {range.end ?? '无日期'}。沿用当前筛选范围。</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">记录类型<select className={BI_SELECT} value={kind}
            onChange={(e) => navigate({ sourceKind: e.target.value as PostingKind })}>
            {Object.entries(POSTING_KINDS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); navigate({ sourceSearch: search.trim() }); }}>
            <label className="grid gap-1 text-sm">查找来源记录<Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={200} placeholder="名称、订单号或来源编号" /></label>
            <Button variant="outline" type="submit">查找</Button></form>
          <Button variant="outline" onClick={() => navigate({ sourceDescending: !(location.sourceDescending ?? true) })}>{location.sourceDescending === false ? '日期从早到晚' : '日期从晚到早'}</Button>
          {activeSearch && <Button variant="ghost" onClick={() => navigate({ sourceSearch: '' })}>清除明细搜索</Button>}
        </div>
        {location.sourceOrderId && <p className="text-sm">订单 {location.sourceOrderId} <Button variant="link" onClick={() => navigate({ sourceOrderId: undefined })}>查看所有订单</Button></p>}
        <p className="text-sm text-muted-foreground">{kind === 'expense' ? '每行展示一笔费用在当前范围内的金额。按订单分摊的费用可有多行，展开可查看原始整笔金额。' :
          kind === 'refund' ? '每行对应一笔已完成的退款。展开可核对原单付款、实际退款时间及收回的商品成本。' :
            '每行对应一个已付款的订单明细。展开可查看平台原始订单号、原币金额和付款时的商品成本。'}</p>
        {problem && <BiNotice error>{problem} <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>重试</Button></BiNotice>}
        <div ref={area} style={!data && !problem ? { minHeight: height } : undefined} aria-busy={!data && !problem}>
          {!data && !problem && <p role="status">正在读取来源记录…</p>}
          {data && <>
            {data.rows.map((row) => <details key={row.key} className="mb-2 rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm">
                <span className="mr-3">{row.date}</span><strong className="mr-3 break-all">{row.source_id}</strong>
                <span className="mr-3">{row.listing_name ?? row.store_name ?? '未归属店铺'}</span>
                <span className="tabular-nums">{decimalLabel(row.amount_cny)}{row.amount_cny != null && ' 元'}</span>
              </summary>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {Object.entries({
                  '店铺': row.store_name ?? '未归属店铺', '订单号': row.order_id, '平台原始订单号': row.platform_order_id,
                  '订单明细编号': row.line_id, '平台商品': row.listing_name,
                  '付款时的核算资料': row.payment_missing && (row.payment_missing.map((reason) => MISSING_AT_PAYMENT[reason]).join('、') || '标准规格、成本及所需汇率齐全'),
                  '原单付款时间': row.paid_at && localTime(row.paid_at),
                  '原单明细付款': row.line_paid_amount && decimalLabel(row.line_paid_amount) + ' ' + row.currency,
                  '实际发生时间': row.occurred_at && localTime(row.occurred_at),
                  '原始整笔金额': kind !== 'sale' ? decimalLabel(row.original_amount) + ' ' + row.currency : undefined,
                  '原始整笔费用（元）': kind === 'expense' ? decimalLabel(row.source_amount_cny) : undefined,
                  '当前范围金额（元）': decimalLabel(row.amount_cny),
                  [kind === 'refund' ? '收回的商品成本（元）' : '商品成本（元）']: kind !== 'expense' ? decimalLabel(row.cost_cny) : undefined,
                  '退款类型': row.refund_type && CHOICE_LABELS[row.refund_type],
                  '费用类别': row.expense_type && CHOICE_LABELS[row.expense_type],
                  '费用归属方式': row.allocation_method && CHOICE_LABELS[row.allocation_method],
                }).filter(([, value]) => value != null).map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}
              </dl>
            </details>)}
            {!data.rows.length && <p className="py-5 text-sm text-muted-foreground">此页没有符合条件的来源记录。</p>}
            <BiPagination page={page} total={data.total} label="付款退款费用明细分页" change={(sourcePage) => navigate({ sourcePage })} />
          </>}
        </div>
      </div>
    </SheetContent>
  </Sheet>;
}
