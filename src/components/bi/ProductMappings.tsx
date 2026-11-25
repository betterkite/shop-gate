'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BiNotice, BiPagination, BI_PANEL, BI_SELECT } from './BiPrimitives';
import { type Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { mappingDirectorySchema, scopeMatches, type MappingDirectory, type OverviewLocation } from '@/lib/bi/overview-contracts';

const statusLabels = { all: '全部状态', mapped: '已对应', missing: '尚未对应' };
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const businessTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium',
});

export function ProductMappings({ workspaceId, dataset, location, periodEnd, navigate, canManage }: {
  workspaceId: string; canManage: boolean; dataset: Dataset; location: OverviewLocation; periodEnd: string | null;
  navigate: (change: Partial<OverviewLocation>) => void;
}) {
  const asOf = location.mappingDate ?? periodEnd ?? businessDate.format(new Date());
  const search = location.mappingSearch ?? '';
  const page = location.mappingPage ?? 1;
  const sort = location.mappingSort ?? 'key';
  const status = location.mappingStatus ?? 'all';
  const [text, setText] = useState(search);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ body: string; table: MappingDirectory } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(220);
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    options: { kind: 'mapping', as_of: asOf, mapping_status: status === 'all' ? undefined : status, search, page,
      sort, descending: location.mappingDescending ?? false, channel_id: location.channelId, store_id: location.storeId,
      sku_id: location.skuId, product_id: location.productId, listing_id: location.listingId, category: location.category } });
  useEffect(() => setText(search), [search]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    readBi('/api/bi/references', mappingDirectorySchema, { method: 'POST', body, signal: controller.signal })
      .then((table) => {
        if (!scopeMatches(workspaceId, dataset, table) || table.as_of !== asOf || table.page !== page) {
          throw new Error('商品目录的日期或范围发生变化，请重新读取。');
        }
        if (!controller.signal.aborted) setResult({ body, table });
      }).catch((e) => { if (!controller.signal.aborted) setError(dataErrorMessage(e)); });
    return () => controller.abort();
  }, [body, dataset, workspaceId, asOf, page, attempt]);
  const data = result?.body === body ? result.table : null;
  useEffect(() => { if (area.current && data) setHeight(area.current.getBoundingClientRect().height); }, [data]);
  return <section className={BI_PANEL} aria-label="平台商品与标准规格">
    <h3 className="text-lg font-semibold">平台商品与标准规格</h3>
    <p className="mt-1 text-sm text-muted-foreground">查看每个平台货号对应哪种规格、售出一份相当于多少标准单位。目录按所选平台、店铺和商品范围列出全部货号，包括没有成交的商品。对应关系取查询当天结束时生效的规则，订单按实际付款时的规则核算。</p>
    <div className="my-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">查询日期（北京时间）<Input type="date" value={asOf}
        onChange={(e) => navigate({ mappingDate: e.target.value || undefined })} /></label>
      <label className="grid gap-1 text-sm">规格对应状态<select className={BI_SELECT} value={status}
        onChange={(e) => navigate({ mappingStatus: e.target.value as keyof typeof statusLabels })}>
        {Object.entries(statusLabels).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label className="grid gap-1 text-sm">目录排序<select className={BI_SELECT} value={sort}
        onChange={(e) => navigate({ mappingSort: e.target.value as 'key' | 'name' })}>
        <option value="key">平台商品编号</option><option value="name">商品名称</option></select></label>
      <Button variant="outline" onClick={() => navigate({ mappingDescending: !location.mappingDescending })}>{location.mappingDescending ? '降序' : '升序'}</Button>
      <form className="flex max-w-full items-end gap-2" onSubmit={(e) => { e.preventDefault(); navigate({ mappingSearch: text.trim() }); }}>
        <label className="grid gap-1 text-sm">查找商品或编码<Input maxLength={200} value={text} placeholder="商品名、平台货号或标准规格"
          onChange={(e) => setText(e.target.value)} /></label><Button type="submit">查找</Button>
      </form>
      {search && <Button variant="outline" onClick={() => navigate({ mappingSearch: '' })}>清除目录搜索</Button>}
    </div>
    {error && <BiNotice error>{error} <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>重新读取目录</Button></BiNotice>}
    <div ref={area} style={!data && !error ? { minHeight: height } : undefined}>
      {!data && !error && <p role="status" className="p-3 text-sm">正在读取规格对应关系…</p>}
      {data && <>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
          <thead><tr>{['平台商品与货号', '销售平台与店铺', '商品与标准规格', '单位换算', '生效期间（北京时间）'].map((h) => <th className="p-2" key={h}>{h}</th>)}</tr></thead>
          <tbody>{data.rows.map((row) => <tr key={row.key} className="border-t border-border align-top">
            <th className="p-2 font-normal">{row.name}<p>平台货号 {row.platform_sku_id}</p><p className="text-xs text-muted-foreground">平台商品编号 {row.key}</p>
              <Button variant="link" size="sm" className="px-0" onClick={() => navigate({ listingId: row.key })}>选择此货号继续分析</Button>
              <Button variant="link" size="sm" className="px-0" onClick={() => navigate({ listingId: row.key, sourceKind: 'sale' })}>查看所选期间付款明细</Button>
              <Button variant="link" size="sm" className="px-0" onClick={() => navigate({ costListingId: row.key })}>查看店铺成本依据</Button>
              {canManage && <Button variant="outline" size="sm" onClick={() => navigate({ editMappingId: row.key })}>维护规格对应</Button>}</th>
            <td className="p-2">{row.channel_name}<p>{row.store_name} · {row.store_id}</p></td>
            <td className="p-2">{row.sku_id ? <>{row.product_name}<p>{row.sku_name} · {row.sku_id}</p></> : statusLabels[row.mapping_status]}</td>
            <td className="p-2">{row.multiplier !== null ? '1 ' + row.listing_unit + ' = ' + row.multiplier.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') + ' ' + row.unit : '待确认'}</td>
            <td className="p-2">{row.valid_from ? <>从 {businessTime.format(new Date(row.valid_from))}<p>{row.valid_to ? '至 ' + businessTime.format(new Date(row.valid_to)) + ' 前' : '持续生效'}</p></> : '暂无可用规则'}</td>
          </tr>)}</tbody></table></div>
        {!data.rows.length && <p className="p-4 text-sm">{data.total ? '这一页没有商品，可返回上一页。' : '当前条件下没有符合的货号。'}</p>}
        <BiPagination label="规格对应关系分页" page={page} total={data.total} change={(mappingPage) => navigate({ mappingPage })} />
      </>}
    </div>
  </section>;
}
