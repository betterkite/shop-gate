'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BI_PANEL, BI_SELECT, BiNotice, BiPagination } from '@/components/bi/BiPrimitives';
import { decimalLabel, EXPENSE_TYPE_LABELS, type Dataset } from '@/lib/bi/data-contracts';
import { ProductPerformance } from './ProductPerformance';
import { exportRanking } from '@/lib/bi/ranking-export';
import { dataErrorMessage, readBi, saveBiFile } from '@/lib/bi/data-browser';
import { DIMENSION_LABELS, sectionHref, ledgerTableSchema, overviewQuery, scopeMatches,
  type LedgerTable, type OverviewLocation, type Overview } from '@/lib/bi/overview-contracts';
import { metricUnit, PRODUCT_CONDITIONS, quantityUnit, rankingMetrics, type ProductCondition, RANK_METRICS, type RankingSection, type RankMetric } from '@/lib/bi/sections';

type Props = {
  section: RankingSection | 'profit'; workspaceId: string; dataset: Dataset; location: OverviewLocation;
  range: Overview['range']; targetMonth?: string; canManage: boolean; navigate: (change: Partial<OverviewLocation>) => void; refresh: number;
};
const filterFields = { channel: 'channelId', store: 'storeId', product: 'productId', sku: 'skuId', listing: 'listingId' } as const;

export function RankedOperations({ section, workspaceId, dataset, location, range, targetMonth, canManage, navigate, refresh }: Props) {
  const profit = section === 'profit';
  const dimension = profit ? location.profitGroup ?? 'channel' : section === 'channels' ? 'channel' : section === 'stores' ? 'store' : location.rankGrain ?? 'product';
  const filters = overviewQuery(location);
  const measures = rankingMetrics({ ...filters, dimension }, profit);
  const metrics = measures.map((id) => [id, RANK_METRICS[id]] as const);
  const showUnits = measures.includes('standard_quantity');
  const name = DIMENSION_LABELS[dimension];
  const page = location.rankPage ?? 1;
  const sort = location.rankSort && metrics.some(([id]) => id === location.rankSort) ? location.rankSort : 'accounted_contribution';
  const descending = location.rankDescending ?? true;
  const keyword = location.rankSearch ?? '';
  const [text, setText] = useState(keyword);
  const [result, setResult] = useState<{ body: string; table: LedgerTable } | null>(null);
  const [problem, setProblem] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const exportRequest = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(420);
  useEffect(() => { setText(keyword); }, [keyword]);

  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  const query = { ...filters, ...(range.start && { start: range.start }), ...(range.end && { end: range.end }),
    dimension, sort, descending };
  const body = JSON.stringify({ ...scope, query: { ...query, page, page_size: 20 } });
  useEffect(() => {
    setExportStatus(''); setExporting(false);
    return () => { exportRequest.current?.abort(); exportRequest.current = null; };
  }, [body]);

  async function download() {
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExportStatus(''); setExporting(true);
    try {
      const { file, total } = await exportRanking(scope, query, controller.signal, profit);
      if (controller.signal.aborted) return;
      saveBiFile(file, [name, dataset.dataset_id, 'v' + dataset.version, range.start, range.end].filter(Boolean).join('-') + '.csv');
      setExportStatus('已导出全部 ' + total + ' 项。');
    } catch (error) {
      if (!controller.signal.aborted) setExportStatus(dataErrorMessage(error));
    } finally {
      if (exportRequest.current === controller) { exportRequest.current = null; setExporting(false); }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setProblem('');
    readBi('/api/bi/query', ledgerTableSchema, { method: 'POST', body, signal: controller.signal })
      .then((table) => {
        if (!scopeMatches(workspaceId, dataset, table) || table.page !== page) throw new Error('经营明细的范围或页码已变化，请刷新。');
        if (!controller.signal.aborted) setResult({ body, table });
      })
      .catch((error) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [body, workspaceId, dataset, page, refresh, retry]);
  const data = result?.body === body ? result.table : null;
  useEffect(() => {
    if (panel.current && data) setHeight(Math.max(420, panel.current.getBoundingClientRect().height));
  }, [data]);

  function filterPerformance(condition: ProductCondition | undefined) {
    if (!condition || !range.start || !range.end) return navigate({ groupCondition: undefined });
    const grain = condition === 'missing_mapping' ? 'listing' : location.rankGrain ?? 'product';
    navigate({ groupCondition: condition, conditionGrain: grain, rankGrain: grain, conditionStart: range.start, conditionEnd: range.end });
  }
  const costOrMapping = location.groupCondition === 'missing_cost' || location.groupCondition === 'missing_mapping';

  return <>{section === 'products' && <ProductPerformance scope={scope} query={query} dimension={location.rankGrain ?? 'product'}
    select={(key) => navigate({ [filterFields[dimension]]: key })} />}
    <section ref={panel} className={BI_PANEL} aria-label={name + '经营明细'} style={!data && !problem ? { minHeight: height } : undefined}>
    <h3 className="text-lg font-semibold">{name}经营明细</h3>
    <div className="my-4 flex flex-wrap items-end gap-3">
      {profit && <label className="grid gap-1 text-sm">利润分组<select className={BI_SELECT} value={dimension}
        onChange={(e) => navigate({ profitGroup: e.target.value as OverviewLocation['profitGroup'] })}>
        {(['channel', 'store', 'product', 'sku', 'listing'] as const).map((id) => <option key={id} value={id}>{DIMENSION_LABELS[id]}</option>)}
      </select></label>}
      {section === 'products' && <label className="grid gap-1 text-sm">查看方式
        <select className={BI_SELECT} value={dimension} onChange={(e) => navigate({ rankGrain: e.target.value as OverviewLocation['rankGrain'] })}>
          <option value="product">商品</option><option value="sku">标准规格</option><option value="listing">平台商品</option>
        </select></label>}
      {section === 'products' && <>
        <label className="grid gap-1 text-sm">筛选商品表现<select className={BI_SELECT} value={location.groupCondition ?? ''}
          onChange={(e) => filterPerformance(e.target.value as ProductCondition || undefined)}>
          <option value="">全部表现</option>
          {Object.entries(PRODUCT_CONDITIONS).map(([key, label]) => <option key={key} value={key}
            disabled={!range.start || !range.end || (key === 'high_refund' && location.refundBasis !== 'payment')}>{label}</option>)}</select></label>
        <Button variant="outline" onClick={() => navigate({ groupCondition: undefined, rankSort: 'net_sales', rankDescending: true })}>按畅销程度排名</Button>
        <Button variant="outline" onClick={() => navigate({ groupCondition: undefined, rankSort: 'accounted_contribution', rankDescending: true })}>按经营贡献排名</Button></>}
      <label className="grid gap-1 text-sm">排序指标<select className={BI_SELECT} value={sort}
        onChange={(e) => navigate({ rankSort: e.target.value as RankMetric })}>
        {metrics.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <Button variant="outline" onClick={() => navigate({ rankDescending: !descending })}>{descending ? '从高到低' : '从低到高'}</Button>
      <form className="flex max-w-full items-end gap-2" onSubmit={(e) => { e.preventDefault(); navigate({ rankSearch: text.trim() }); }}>
        <label className="grid gap-1 text-sm">搜索交易记录<Input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="名称或编号" /></label>
        <Button type="submit" variant="outline">搜索</Button>
      </form>
      <Button variant="outline" onClick={() => navigate({ sourceKind: profit ? 'expense' : costOrMapping ? 'sale' : 'refund' })}>查看付款、退款和费用</Button>
      <Button variant="outline" disabled={exporting || !data} onClick={() => { void download(); }}>
        {exporting ? '正在导出…' : '导出全部筛选结果'}</Button>
      {keyword && <Button variant="ghost" onClick={() => navigate({ rankSearch: '' })}>清除搜索</Button>}
    </div>
    {location.groupCondition && location.conditionGrain && <div className="my-3 flex flex-wrap items-center gap-2 text-sm">
      <p>当前只看符合“{PRODUCT_CONDITIONS[location.groupCondition]}”的{DIMENSION_LABELS[location.conditionGrain]}，判断期间为 {location.conditionStart} 至 {location.conditionEnd}。
        {location.groupCondition === 'missing_mapping' && '按平台货号查找。这些货号至少有一条交易在付款时还没有对应标准规格，因此算不出那笔交易售出了多少标准单位。'}
        {location.groupCondition === 'missing_cost' && '这些商品至少有一条交易已对应到标准规格，但付款时找不到适用的成本记录。'}
        {costOrMapping && '列表汇总所选商品的全部交易。打开付款明细可逐笔核对。'}
        {location.groupCondition === 'incomplete' && '待核算涵盖金额、成本、费用归属或单位换算缺项。'}
        {(location.groupCondition === 'low_margin' || location.groupCondition === 'high_refund') && '比例缺少计算依据的商品不参加此项筛选。'}</p>
      {section === 'products' && range.start && range.end && (location.conditionStart !== range.start || location.conditionEnd !== range.end || (location.groupCondition !== 'missing_mapping' && location.conditionGrain !== dimension)) &&
        <Button variant="outline" onClick={() => filterPerformance(location.groupCondition)}>按当前期间和方式重新判断</Button>}
      <Button variant="ghost" onClick={() => navigate({ groupCondition: undefined })}>清除商品表现筛选</Button></div>}
    {exportStatus && <p role="status" className="my-3 text-sm">{exportStatus}</p>}
    {problem && <BiNotice error>{problem} <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>重试</Button></BiNotice>}
    {!problem && !data && <p role="status" className="py-5 text-sm text-muted-foreground">正在读取经营记录…</p>}
    {data && <>
      {data.rows.length > 0 && <RankComparison data={data} name={name} onSelect={(key) => navigate({ [filterFields[dimension]]: key })} />}
      <p className="mb-3 text-sm text-muted-foreground">{data.total ? '全范围付款订单 ' + decimalLabel(data.summary.metrics.order_count) + ' 笔，已核算经营贡献 ' + decimalLabel(data.summary.metrics.accounted_contribution) + ' 元。' : '此范围没有匹配的经营记录。'} 付款订单按订单编号去重。</p>
      {!profit && section !== 'products' && data.rows.some((row) => row.expense_breakdown) && <details className="mb-4 rounded-xl border border-border p-4">
        <summary className="cursor-pointer font-semibold">查看商品成本与各项费用</summary>
        <p className="my-3 text-sm text-muted-foreground">金额以元计，负数是费用调减。同一笔费用按它实际归属的平台或店铺计入。缺少汇率时，会同时列出已有金额。</p>
        <div className="overflow-x-auto"><table className="w-full min-w-max text-sm">
          <thead><tr><th className="p-2 text-left">{name}</th><th className="p-2 text-right">商品成本</th>
            {Object.values(EXPENSE_TYPE_LABELS).map((label) => <th className="p-2 text-right" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.rows.map((row) => <tr key={row.key} className="border-t border-border">
            <th className="p-2 text-left">{row.name}</th><td className="p-2 text-right tabular-nums">{decimalLabel(row.metrics.product_cost)}</td>
            {Object.keys(EXPENSE_TYPE_LABELS).map((id) => {
              const part = row.expense_breakdown?.[id];
              let value = row.expense_breakdown ? '0.00' : '待核算';
              if (part) value = part.amount == null ? '待核算（已有 ' + decimalLabel(part.known_amount) + ' 元）' : decimalLabel(part.amount);
              return <td className="p-2 text-right tabular-nums" key={id}>{value}</td>;
            })}</tr>)}</tbody></table></div></details>}
      <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-max text-left text-sm">
        {showUnits && <caption className="caption-top p-3 text-left text-sm text-muted-foreground">
          标准销量按付款时的单位换算。平均售价按成交金额计算，历史单位成本只用已有成本依据的销量加权。退货不改变原单的单位成本。
        </caption>}
        <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="p-3">{name}</th>
          {metrics.map(([id, label]) => <th className="p-3 text-right" key={id}>{label}（{metricUnit(id)}）</th>)}
          {showUnits && <th className="p-3">标准单位</th>}<th className="p-3">关联记录</th></tr></thead>
        <tbody>{data.rows.map((row) => {
          const filter = { [filterFields[dimension]]: row.key };
          const related = dimension === 'store' ? 'products' : 'stores';
          return <tr className="border-t border-border" key={row.key}>
            <th scope="row" className="max-w-52 whitespace-normal break-words p-3">{row.name}<span className="block text-xs font-normal text-muted-foreground">{row.key === '__unattributed__' ? '尚无明确归属' : row.key}</span></th>
            {metrics.map(([id]) => <td key={id} className="p-3 text-right tabular-nums">{decimalLabel(row.metrics[id], metricUnit(id) === '%')}</td>)}
            {showUnits && <td className="p-3">{quantityUnit(row.quality)}</td>}
            <td className="p-3">{row.key !== '__unattributed__' && <div className="flex flex-wrap gap-3">
              <Link className="text-primary underline" href={sectionHref(related, { ...location, workspaceId, ...filter })}>{related === 'stores' ? '查看店铺' : '查看商品'}</Link>
              {section === 'products' && <Link className="text-primary underline" href={sectionHref('channels', { ...location, workspaceId, ...filter })}>查看同款的平台表现</Link>}
              {section === 'stores' && targetMonth && <Button size="sm" variant="outline"
                onClick={() => navigate({ editStoreId: row.key, targetMonth })}>{canManage ? '维护月度目标' : '查看月度目标'}</Button>}
              <Button size="sm" variant="outline" onClick={() => navigate({ ...filter, sourceKind: 'expense' })}>查看费用和退款</Button>
              <Button size="sm" variant="outline" onClick={() => navigate({ ...filter, detailDimension: 'order', detailSearch: keyword, detailPage: 1 })}>查看订单</Button>
            </div>}</td>
          </tr>;
        })}</tbody></table></div>
      <BiPagination page={page} total={data.total} label={name + '经营明细分页'} change={(rankPage) => navigate({ rankPage })} />
    </>}
  </section></>;
}


function RankComparison({ data, name, onSelect }: { data: LedgerTable; name: string; onSelect: (key: string) => void }) {
  const series = ['net_sales', 'accounted_contribution'] as const;
  const maximum = data.rows.reduce((max, row) => Math.max(max, ...series.map((metric) =>
    Math.abs(Number(row.metrics[metric] ?? 0)))), 0);
  return <details open className="mb-5 rounded-xl border border-border p-4">
    <summary className="cursor-pointer font-semibold">净销售额与已核算经营贡献</summary>
    <div className="my-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-sm bg-primary" />净销售额</span>
      <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-sm bg-amber-500" />已核算经营贡献</span>
      <span>本页 {data.rows.length} 项共用刻度，零线左侧为负数。点击{name}可查看其经营范围。</span>
    </div>
    <ul className="divide-y divide-border">{data.rows.map((row) => <li key={row.key}
      className="grid gap-2 py-2 sm:grid-cols-[minmax(8rem,1fr)_minmax(8rem,3fr)_minmax(8rem,1fr)] sm:items-center">
      {row.key === '__unattributed__' ? <span className="break-words text-sm">{row.name}</span> :
        <button className="break-words text-left text-sm font-medium text-primary hover:underline"
          type="button" onClick={() => onSelect(row.key)}>{row.name}</button>}
      <div aria-hidden="true" className="relative grid h-8 items-center gap-1 border-y border-border/50 py-1">
        <span className="absolute inset-y-0 left-1/2 border-l border-border" />
        {series.map((metric) => {
          const value = row.metrics[metric];
          const width = value == null || !maximum ? 0 : Math.abs(Number(value)) / maximum * 50;
          return <span className="relative block h-2" key={metric}><i
            className={'absolute h-full rounded-sm ' + (metric === 'net_sales' ? 'bg-primary' : 'bg-amber-500')}
            style={{ left: (Number(value) < 0 ? 50 - width : 50) + '%', width: width + '%' }} /></span>;
        })}
      </div>
      <div className="text-xs text-muted-foreground sm:text-right">{series.map((metric) => <p key={metric}
        className="tabular-nums"><span className="sr-only">{RANK_METRICS[metric]}</span>{decimalLabel(row.metrics[metric])}{row.metrics[metric] != null && ' 元'}</p>)}</div>
    </li>)}</ul>
  </details>;
}
