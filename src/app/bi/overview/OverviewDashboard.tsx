'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, CheckCircle2, CircleAlert, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BI_PANEL, BI_SELECT, BiNotice, BiPagination } from '@/components/bi/BiPrimitives';
import { decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { overviewSchema, overviewQuery, scopeMatches, KPI_LABELS, COMPARISON_LABELS, QUALITY_LABELS, REFERENCE_LABELS,
  type Overview, type OverviewLocation } from '@/lib/bi/overview-contracts';
import type { OverviewNavigate } from './OverviewWorkspace';
import { OverviewTrend } from './OverviewTrend';
import { OverviewSources } from './OverviewSources';
import { TargetEditor } from './TargetEditor';
import { ReferencePicker } from './ReferencePicker';

type Props = { workspaceId: string; dataset: Dataset; canManage: boolean; location: OverviewLocation;
  navigate: OverviewNavigate; refresh: number; onCommitted: () => void };
export function OverviewDashboard({ workspaceId, dataset, canManage, location, navigate, refresh, onCommitted }: Props) {
  const [response, setResponse] = useState<{ key: string; data: Overview } | null>(null);
  const [problem, setProblem] = useState(''); const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<Pick<OverviewLocation, 'start' | 'end'> | null>(null);
  const area = useRef<HTMLDivElement>(null); const [height, setHeight] = useState(650);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    (opener.current?.isConnected ? opener.current : area.current)?.focus({ preventScroll: true });
  }, []);
  const body = JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
    options: { query: overviewQuery(location), interval: location.interval, channel_metric: location.channelMetric,
      channel_page: location.channelPage, target_page: location.targetPage, ...(location.targetMonth ? { target_month: location.targetMonth } : {}) } });
  useEffect(() => {
    const controller = new AbortController(); setProblem('');
    const expected = JSON.parse(body) as { workspace_id: string; dataset_id: string; version: number };
    readBi('/api/bi/overview', overviewSchema, { method: 'POST', body, signal: controller.signal }).then((data) => {
      if (!scopeMatches(expected.workspace_id, expected, data)) throw new Error('总览数据的范围或版本不一致，请刷新后重试。');
      if (!controller.signal.aborted) setResponse({ key: body, data });
    }).catch((error) => { if (!controller.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [body, refresh, retry]);
  const data = response?.key === body ? response.data : null;
  useEffect(() => { if (data && area.current) setHeight(Math.max(650, area.current.getBoundingClientRect().height)); }, [data]);
  const go: OverviewNavigate = (change) => {
    if ((change.editStoreId || change.detailDimension || change.filterKind)
        && !location.editStoreId && !location.detailDimension && !location.filterKind) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setHeight(Math.max(650, area.current?.getBoundingClientRect().height ?? 650)); navigate(change);
  };
  const month = data?.targets?.month ?? location.targetMonth;
  const selectPeriod = (period: Pick<OverviewLocation, 'start' | 'end'>) => { setUndo({ start: location.start, end: location.end }); go(period); };
  return <>
    <OverviewFilters key={`${location.start}:${location.end}`} location={location} data={data} navigate={go} />
    {undo && <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span>已从趋势图选择日期范围。</span><Button size="sm" variant="outline" onClick={() => { go(undo); setUndo(null); }}>撤销日期选择</Button></div>}
    {notice && <BiNotice>{notice}</BiNotice>}
    <div ref={area} tabIndex={-1} className="grid min-w-0 grid-cols-1 gap-5 outline-none" style={!data ? { minHeight: height } : undefined} aria-busy={!data && !problem}>
      {!data && !problem && <div role="status" className={`${BI_PANEL} h-40 animate-pulse text-sm text-muted-foreground`}>正在读取所选范围的同版本经营数据…</div>}
      {problem && <div className="self-start"><BiNotice error>{problem}<Button variant="outline" size="sm" className="ml-3" onClick={() => setRetry((v) => v + 1)}>重新读取</Button></BiNotice></div>}
      {data && <>
        <OverviewIndicators data={data} />
        <OverviewCoverage data={data} />
        <OverviewTrend trend={data.trend} page={location.trendPage} navigate={go} onSelect={selectPeriod} />
        <section className={BI_PANEL} aria-label="销售平台贡献">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">销售平台贡献</h3><p className="mt-1 text-sm text-muted-foreground">金额与占比按全部所选数据计算。点击平台可继续查看相关店铺。</p></div>
            <label className="text-sm">排序依据 <select className={BI_SELECT} aria-label="平台贡献排序" value={location.channelMetric} onChange={(event) => go({ channelMetric: event.target.value as OverviewLocation['channelMetric'] })}><option value="net_sales">净销售额</option><option value="accounted_contribution">已核算经营贡献</option></select></label></div>
          {data.channels.share_states?.[location.channelMetric] !== 'comparable' && data.channels.total > 0 && <p className="mt-3 text-xs leading-6 text-muted-foreground">{data.channels.share_states?.[location.channelMetric] === 'incomplete' ? '有金额待核算，暂不计算贡献占比。' : '存在负数或合计不为正，金额保留原值，不计算容易误解的贡献占比。'}</p>}
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[660px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-3">销售平台</th><th className="p-3 text-right">净销售额（元）</th><th className="p-3 text-right">已核算经营贡献（元）</th><th className="p-3 text-right">所选指标占比</th><th className="p-3">查看范围</th></tr></thead><tbody>
            {data.channels.rows.map((row) => <tr key={row.key} className="border-t border-border"><th className="max-w-60 break-words p-3 font-medium">{row.name}</th><td className="p-3 text-right tabular-nums">{decimalLabel(row.metrics.net_sales)}</td><td className="p-3 text-right tabular-nums">{decimalLabel(row.metrics.accounted_contribution)}</td><td className="p-3 text-right tabular-nums">{row.shares?.[location.channelMetric] == null ? '不计算' : decimalLabel(row.shares[location.channelMetric], true)}</td><td className="p-3">{row.key === '__unattributed__' ? <span className="text-xs text-muted-foreground">费用归属尚未明确</span> : <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => go({ detailDimension: 'store', detailChannelId: row.key, detailStoreId: undefined, detailSearch: '', detailPage: 1 })}>相关店铺</Button><Button size="sm" variant="ghost" onClick={() => go({ channelId: row.key })}>筛选此平台</Button></div>}</td></tr>)}
          </tbody></table></div>{!data.channels.rows.length && <p className="p-5 text-sm text-muted-foreground">{data.channels.total ? '此页没有记录，请返回上一页。' : '所选期间没有平台经营记录。'}</p>}
          <BiPagination label="平台贡献分页" page={data.channels.page} total={data.channels.total} change={(channelPage) => go({ channelPage })} />
        </section>
        <section className={BI_PANEL} aria-label="经营提醒"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-lg font-semibold"><CircleAlert className="h-5 w-5 text-primary" />值得查看的变化</h3><Button size="sm" variant="outline" onClick={() => go({ detailDimension: 'line', detailChannelId: undefined, detailStoreId: undefined, detailPage: 1, detailSearch: '' })}>查看全部来源明细<ArrowUpRight className="h-4 w-4" /></Button></div>
          <p className="mt-2 text-sm text-muted-foreground">下面是由记录触发的提醒，原因还需要结合交易、退款、成本与费用核对。</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">{data.attention.rows.map((item) => <article key={item.id} className="rounded-xl border border-border bg-muted/20 p-4"><h4 className="font-medium">{item.title}</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p><p className="mt-3 text-xs text-muted-foreground">出现条件：{item.rule}</p></article>)}</div>
          {!data.attention.total && <p className="mt-4 rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">{data.trend.rows.some((row) => row.state === 'recorded') ? '当前记录未触发上述提醒；这不代表所有经营问题都已排除。' : '当前范围没有经营记录，暂不判断经营变化。'}</p>}
        </section>
        <section className={BI_PANEL} aria-label="月度经营目标"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-lg font-semibold"><Target className="h-5 w-5 text-primary" />月度经营目标</h3><p className="mt-2 text-sm text-muted-foreground">{data.targets?.scope_note ?? '选择月份，查看所有店铺的整月目标与完成情况。'}</p></div>
          <label className="flex items-center gap-2 text-sm">目标月份<Input type="month" aria-label="目标月份" className="w-44" value={month?.slice(0, 7) ?? ''} onChange={(event) => { if (/^[1-9]\d{3}-\d{2}$/.test(event.target.value)) go({ targetMonth: `${event.target.value}-01`, targetPage: 1 }); }} /></label></div>
          {data.targets && <><p className="mt-3 text-xs leading-6 text-muted-foreground">共 {data.targets.total} 家店铺，{data.targets.configured_count} 家已设净销售额目标；已设置的目标合计 {data.targets.sales_target_total === null ? '暂无' : `${decimalLabel(data.targets.sales_target_total)} 元`}。目标为零或负数时不计算完成比例。</p>
            <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr>{['店铺', '净销售额目标（元）', '整月净销售额（元）', '销售完成比例', '经营贡献目标（元）', '完整经营贡献（元）', '贡献完成比例', '目标维护'].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{data.targets.rows.map((row) => <tr className="border-t border-border" key={row.store_id}>
              <th className="max-w-52 break-words p-3 font-medium">{row.store_name}</th><td className="p-3 tabular-nums">{row.sales_target === null ? '未设定' : decimalLabel(row.sales_target)}</td><td className="p-3 tabular-nums">{row.actual_state === 'no_records' ? '无经营记录' : decimalLabel(row.net_sales)}</td><td className="p-3 tabular-nums">{row.completion_ratio === null ? '不计算' : decimalLabel(row.completion_ratio, true)}</td><td className="p-3 tabular-nums">{row.profit_target === null ? '未设定' : decimalLabel(row.profit_target)}</td><td className="p-3 tabular-nums">{row.actual_state === 'no_records' ? '无经营记录' : decimalLabel(row.contribution_profit)}</td><td className="p-3 tabular-nums">{row.profit_completion_ratio === null ? '不计算' : decimalLabel(row.profit_completion_ratio, true)}</td><td className="p-3"><Button size="sm" variant="outline" onClick={() => go({ editStoreId: row.store_id })}>{canManage ? (row.state === 'not_set' ? '设定目标' : '修改目标') : '查看目标'}</Button></td>
            </tr>)}</tbody></table></div>
            {!data.targets.rows.length && <p className="p-5 text-sm text-muted-foreground">{data.targets.total ? '此页没有店铺，请返回上一页。' : '当前范围没有店铺。'}</p>}
            <BiPagination label="店铺目标分页" page={data.targets.page} total={data.targets.total} change={(targetPage) => go({ targetPage })} />
          </>}
        </section>
        <footer className="text-xs leading-6 text-muted-foreground">数据截止：{data.data_cutoff ?? '尚无业务日期'} · 数据版本 {data.version} · 核算版本 {data.accounting_revision}。基础经营分析无需调用大模型。已核算经营贡献不等同于财务净利润。</footer>
      </>}
    </div>
    {location.filterKind && <ReferencePicker workspaceId={workspaceId} dataset={dataset} location={location} navigate={go} restoreFocus={restoreFocus} />}
    {data && location.detailDimension && <OverviewSources workspaceId={workspaceId} dataset={dataset} location={location} range={data.range} navigate={go} restoreFocus={restoreFocus} />}
    {data && month && location.editStoreId && <TargetEditor key={`${dataset.dataset_id}:${dataset.version}:${month}:${location.editStoreId}`} workspaceId={workspaceId} dataset={dataset} storeId={location.editStoreId} month={month} initial={data.targets?.rows.find((row) => row.store_id === location.editStoreId)} canManage={canManage} close={() => go({ editStoreId: undefined })} restoreFocus={restoreFocus} committed={() => { setNotice('目标已保存。'); onCommitted(); }} />}
  </>;
}

export function OverviewFilters({ location, data, navigate }: { location: OverviewLocation; data: Overview | null; navigate: OverviewNavigate }) {
  const [start, setStart] = useState(location.start ?? ''); const [end, setEnd] = useState(location.end ?? ''); const [error, setError] = useState('');
  const selections = [
    ['channelId', '平台'], ['storeId', '店铺'], ['productId', '商品'], ['skuId', '规格'], ['listingId', '平台商品'], ['category', '类目'],
  ] as const;
  return <section className={BI_PANEL} aria-label="经营分析范围"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4 text-primary" />当前分析范围</h3><span className="text-xs text-muted-foreground">{data ? `${data.range.start ?? '无日期'} 至 ${data.range.end ?? '无日期'} · 截止 ${data.data_cutoff ?? '尚无记录'}` : '正在确认日期范围'}</span></div>
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (start && end && start > end) { setError('开始日期不能晚于结束日期。'); return; } setError(''); navigate({ start: start || undefined, end: end || undefined }); }}>
      <label className="grid gap-2 text-xs text-muted-foreground">开始日期<Input type="date" aria-label="分析开始日期" value={start} onChange={(e) => setStart(e.target.value)} /></label><label className="grid gap-2 text-xs text-muted-foreground">结束日期<Input type="date" aria-label="分析结束日期" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      <Button variant="outline" type="submit">应用日期</Button><Button variant="ghost" type="button" onClick={() => { setStart(''); setEnd(''); setError(''); navigate({ start: undefined, end: undefined }); }}>恢复最近30天</Button>
      <label className="grid gap-2 text-xs text-muted-foreground">退款统计方式<select className={BI_SELECT} value={location.refundBasis} onChange={(e) => navigate({ refundBasis: e.target.value as OverviewLocation['refundBasis'] })}><option value="payment">按原订单付款日期</option><option value="occurred">按退款发生日期</option></select></label>
    </form>
    <div className="mt-4 flex flex-wrap gap-2">{Object.entries(REFERENCE_LABELS).map(([kind, name]) => <Button key={kind} size="sm" variant="outline" onClick={() => navigate({ filterKind: kind as keyof typeof REFERENCE_LABELS, filterSearch: '', filterPage: 1 })}>选择{name}</Button>)}</div>
    <div className="mt-3 flex flex-wrap gap-2">{selections.filter(([key]) => location[key] !== undefined).map(([key, name]) => {
      const kind = key === 'category' ? 'category' : key.slice(0, -2);
      const resolved = data?.scope_names?.find((item) => item.kind === kind && item.key === location[key]);
      const label = resolved?.name ?? (data ? `未找到所选对象（${location[key] || '未分类'}）` : '正在读取名称');
      return <Button key={key} variant="secondary" size="sm" className="max-w-full whitespace-normal break-all" onClick={() => navigate({ [key]: undefined })}>{name}：{label} · 清除</Button>;
    })}</div>
    <p className="mt-3 text-xs leading-6 text-muted-foreground">未指定日期时，以数据集最新业务日期为准查看最近30天。筛选目录包含尚无交易的对象；所选范围没有经营记录时会明确说明。</p>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
  </section>;
}

export function OverviewIndicators({ data }: { data: Overview }) {
  const recorded = data.trend.rows.some((row) => row.state === 'recorded');
  return <section aria-label="经营关键指标" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {Object.entries(KPI_LABELS).map(([key, label]) => {
      const metric = data.summary.metrics[key]; const comparison = data.comparison[key]; const ratio = label.unit === '%';
      const unavailable = !recorded ? '无经营记录' : key === 'refund_ratio' && data.range.refund_basis === 'occurred' ? '此口径不计算' : '待核算';
      return <article key={key} className={`${BI_PANEL} relative overflow-hidden`}><p className="text-sm font-medium text-muted-foreground">{label.name}</p>
        <p className="mt-3 break-words text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{!recorded || metric == null ? unavailable : decimalLabel(metric, ratio)}{recorded && metric != null && !ratio && <span className="ml-2 text-xs font-normal text-muted-foreground">{label.unit}</span>}</p>
        <p className="mt-3 min-h-10 text-xs leading-5 text-muted-foreground">{label.description}</p>
        <div className="mt-4 border-t border-border pt-3 text-xs leading-6 text-muted-foreground">{recorded && comparison ? <><p>{COMPARISON_LABELS[comparison.state]}{comparison.growth_ratio !== null ? `：${decimalLabel(comparison.growth_ratio, true)}` : ''}</p>
          {comparison.difference !== null && <p>变化量：{decimalLabel(comparison.difference, ratio).replace('%', ' 个百分点')}{ratio ? '' : ` ${label.unit}`}</p>}
          {data.previous && <p>前期 {data.previous.range.start} 至 {data.previous.range.end}</p>}</> : '没有可比较的经营记录'}</div>
      </article>;
    })}
  </section>;
}

export function OverviewCoverage({ data }: { data: Overview }) {
  const quality = data.summary.quality; const recorded = data.trend.rows.some((row) => row.state === 'recorded');
  const missing = Object.entries(QUALITY_LABELS).filter(([key]) => Number(quality[key]) > 0);
  return <section className={`${BI_PANEL} border-primary/20 bg-primary/5`} aria-label="核算完整度"><div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-primary" /><h3 className="font-semibold">这些数字覆盖了多少经营记录</h3></div>
    <div className="mt-4 grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">已核算收入</p><p className="mt-1 text-xl font-semibold tabular-nums">{recorded ? `${decimalLabel(data.summary.metrics.accounted_revenue)} 元` : '无经营记录'}</p></div><div><p className="text-xs text-muted-foreground">已核算收入占比</p><p className="mt-1 text-xl font-semibold tabular-nums">{recorded && data.summary.metrics.coverage_ratio != null ? decimalLabel(data.summary.metrics.coverage_ratio, true) : '暂不计算'}</p></div><div><p className="text-xs text-muted-foreground">已知付款成交额</p><p className="mt-1 text-xl font-semibold tabular-nums">{recorded ? `${decimalLabel(quality.known_sales_cny)} 元` : '无经营记录'}</p></div></div>
    <p className="mt-4 text-xs leading-6 text-muted-foreground">已核算收入只包含已具备金额和商品成本依据的交易。已知付款成交额可以只覆盖部分记录，不替代完整净销售额。核算不完整时，不显示完整经营贡献利润率。</p>
    {missing.length > 0 ? <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">{missing.map(([key, label]) => <li key={key}>{label}：{String(quality[key])} 项</li>)}</ul> : <p className="mt-3 text-sm">{recorded ? '所选记录未发现上述核算缺项。' : '当前范围没有经营记录，暂不判断完整度。'}</p>}
  </section>;
}
