'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import { reportOptions, reportTable, reportTypes, REPORT_NAMES } from '@/lib/bi/report-contracts';
import { type OverviewLocation } from '@/lib/bi/overview-contracts';
import type { Dataset } from '@/lib/bi/data-contracts';
import { BI_PANEL, BiNotice, BiPagination } from './BiPrimitives';
import { ReportViews } from './ReportViews';
import type { z } from 'zod';

export function ReportCenter({ workspaceId, dataset, location, navigate }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; navigate: (change: Partial<OverviewLocation>) => void;
}) {
  const options = reportOptions(location);
  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  const body = JSON.stringify({ ...scope, options });
  const [result, setResult] = useState<{ body: string; value: z.infer<typeof reportTable> } | null>(null);
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [downloading, setDownloading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void readBi('/api/bi/reports/table', reportTable, { method: 'POST', body, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult({ body, value }); })
      .catch(e => { if (!controller.signal.aborted) setError(dataErrorMessage(e)); });
    return () => controller.abort();
  }, [body, retry]);
  const table = result?.body === body ? result.value : null;
  const labels = result?.value.report_type === options.report_type ? result.value.labels : {};
  const selectedColumns = options.columns.length ? options.columns : Object.keys(labels);
  async function download() {
    setDownloading(true); setError('');
    try {
      const res = await fetch('/api/bi/reports/csv', { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-shopgate-request': 'same-origin' } });
      if (!res.ok || !res.headers.get('content-type')?.startsWith('text/csv')) throw new Error('导出失败，请刷新数据后重试。');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url;
      a.download = REPORT_NAMES[options.report_type] + '-版本' + scope.version + '.csv'; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(dataErrorMessage(e)); }
    finally { setDownloading(false); }
  }
  return <><section className={BI_PANEL} aria-label="经营报表">
    <div className="flex flex-wrap gap-2" aria-label="选择报表">{reportTypes.map(type =>
      <Button key={type} size="sm" variant={type === options.report_type ? 'default' : 'outline'}
        aria-pressed={type === options.report_type} onClick={() => navigate({ reportType: type, reportPage: 1,
          reportColumns: undefined, reportSort: undefined, reportSearch: '', reportDescending: true, savedTopic: undefined })}>{REPORT_NAMES[type]}</Button>)}</div>
    <div className="mt-6 flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">{REPORT_NAMES[options.report_type]}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{options.report_type === 'costs'
        ? '按价格生效日期查看每次登记的规则，调整前后价格保留各自币种。查看某日适用价格请打开商品成本管理。'
        : options.report_type === 'orders' ? '每行对应一条付款明细。成本来自付款时保存的版本，利润包含所选期间内对应的退款和费用。'
        : options.report_type === 'refunds' ? '每行对应一次退款。日期筛选跟随上方选择的付款日期或退款日期。'
        : '金额来自所选期间的经营账本。资料不足的金额显示为待核算。'}</p></div>
      <Button size="sm" variant="outline" disabled={!table || downloading} onClick={() => void download()}>{downloading ? '正在导出…' : '导出全部匹配行'}</Button></div>
    <form key={options.report_type + options.search} className="my-4 flex gap-2" onSubmit={e => {
      e.preventDefault(); navigate({ reportSearch: String(new FormData(e.currentTarget).get('term') ?? '').trim(), reportPage: 1 }); }}>
      <Input name="term" aria-label="搜索报表" maxLength={200} defaultValue={options.search} placeholder="输入编号、名称或报表中的内容" />
      <Button type="submit" variant="outline">搜索</Button></form>
    {error && <BiNotice error>{error} <Button size="sm" onClick={() => setRetry(v => v+1)}>重试</Button></BiNotice>}
    <div className="flex flex-wrap items-center gap-3 text-sm"><details>
      <summary className="cursor-pointer text-primary">选择显示列</summary>
      <div className="mt-2 flex flex-wrap gap-3">{Object.entries(labels).map(([id,label]) =>
        <label key={id}><input type="checkbox" checked={selectedColumns.includes(id)}
          disabled={selectedColumns.length === 1 && selectedColumns[0] === id} onChange={e => {
            const next = Object.keys(labels).filter(k => k === id ? e.target.checked : selectedColumns.includes(k));
            navigate({ reportColumns: next.join(',') }); }} /> {label}</label>)}</div></details>
      {table && <span className="text-muted-foreground">版本 {table.version} · {table.range.start} 至 {table.range.end}</span>}</div>
    {!table && !error && <p role="status" className="py-4" style={{minHeight: Math.min(20,result?.value.rows.length ?? 0)*38}}>正在读取报表…</p>}
    {table && <>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm tabular-nums"><thead><tr>{table.columns.map(k =>
        <th key={k} scope="col" aria-sort={table.sort === k ? table.descending ? 'descending' : 'ascending' : 'none'} className="whitespace-nowrap border-b p-2">
          <button onClick={() => navigate({ reportSort: k, reportDescending: table.sort !== k || !table.descending, reportPage: 1 })}>
            {table.labels[k]} {table.sort === k ? table.descending ? '↓' : '↑' : ''}</button></th>)}</tr></thead>
        <tbody>{table.rows.map(row => <tr key={row.id}>{table.columns.map(k => <td key={k} className="whitespace-nowrap border-b p-2">
          {row.values[k] ?? (['cost_id','sku_id','before_currency','before_cost'].includes(k) ? '未记录' : '待核算')}</td>)}</tr>)}</tbody></table></div>
      {!table.rows.length && <p className="my-3 text-sm">此范围没有匹配记录。可修改日期或清除搜索。</p>}
      <BiPagination label="经营报表分页" total={table.total} page={table.page} change={reportPage => navigate({ reportPage })} /></>}
    <Link className="mt-5 inline-block text-sm text-primary underline" href={'/bi/data?' + new URLSearchParams({workspace_id: workspaceId, dataset_id: dataset.dataset_id})}>
      标准数据导入、导出与批次记录</Link>
  </section><ReportViews scope={scope} options={options} table={table} location={location} navigate={navigate} /></>;
}
