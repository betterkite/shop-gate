'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { BI_PANEL, BiNotice } from './BiPrimitives';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { DIMENSION_LABELS, ledgerTableSchema, scopeMatches, type LedgerTable } from '@/lib/bi/overview-contracts';

type Scope = { workspace_id: string; dataset_id: string; version: number };
type Grain = 'product' | 'sku' | 'listing';

export function ProductPerformance({ scope, query, dimension, select }: {
  scope: Scope; query: Record<string, unknown>; dimension: Grain; select: (key: string) => void;
}) {
  const body = JSON.stringify({ ...scope, query: { ...query, dimension, sort: 'net_sales', descending: true,
    metrics: ['net_sales', 'contribution_margin', 'accounted_contribution'], page: 1, page_size: 20 } });
  const [result, setResult] = useState<{ body: string; data: LedgerTable } | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setFailed('');
    const requested: Scope = JSON.parse(body);
    readBi('/api/bi/query', ledgerTableSchema, { method: 'POST', body, signal: controller.signal }).then((data) => {
      if (!scopeMatches(requested.workspace_id, requested, data) || data.page !== 1) throw new Error('摘要的范围发生变化，请重新读取。');
      if (!controller.signal.aborted) setResult({ body, data });
    }).catch((e) => { if (!controller.signal.aborted) setFailed(dataErrorMessage(e)); });
    return () => controller.abort();
  }, [body, attempt]);
  const data = result?.body === body ? result.data : null;
  return <section className={BI_PANEL} aria-label="商品销售与利润率分布">
    <h3 className="text-lg font-semibold">哪些商品卖得多，利润率如何</h3>
    {failed && <BiNotice error>{failed} <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>重试</Button></BiNotice>}
    {!data && !failed && <p className="my-3 text-sm" role="status">正在读取销售排名…</p>}
    {data && <ProductScatter data={data} dimension={dimension} select={select} />}
  </section>;
}

export function ProductScatter({ data, dimension, select }: { data: LedgerTable; dimension: Grain; select: (key: string) => void }) {
  const rows = data.rows.filter((r) => r.key !== '__unattributed__' && r.metrics.net_sales != null);
  if (!rows.length) return <p className="my-3 text-sm text-muted-foreground">当前范围没有能核对净销售额的{DIMENSION_LABELS[dimension]}。</p>;
  const plotted = rows.filter((r) => r.metrics.contribution_margin != null);
  const x = plotted.map((r) => Number(r.metrics.net_sales));
  const y = plotted.map((r) => Number(r.metrics.contribution_margin) * 100);
  const xmin = Math.min(0, ...x), xmax = Math.max(0, ...x), ymin = Math.min(0, ...y), ymax = Math.max(0, ...y);
  const px = (v: number) => xmax === xmin ? 400 : 75 + (v - xmin) / (xmax - xmin) * 645;
  const py = (v: number) => ymax === ymin ? 92 : 166 - (v - ymin) / (ymax - ymin) * 138;
  return <>
    <p className="my-3 text-sm text-muted-foreground">按净销售额从高到低取前 {data.rows.length} 个分组，完整明细共 {data.total} 项。
      横向越靠右，净销售额越高。纵向越靠上，经营贡献利润率越高。</p>
    {plotted.length ? <svg className="w-full" role="img" viewBox="0 0 760 207" aria-label="商品净销售额与经营贡献利润率，准确数值见下方明细">
      <text x={8} y={15} fontSize={12} fill="currentColor">利润率（%）</text>
      <path d={`M 75 ${py(0)} H 720 M ${px(0)} 28 V 166`} stroke="currentColor" opacity=".35" fill="none" />
      <text x={70} y={py(ymax) - 4} textAnchor="end" fontSize={11} fill="currentColor">{ymax.toFixed(1)}%</text>
      {ymin !== ymax && <text x={70} y={py(ymin)} textAnchor="end" fontSize={11} fill="currentColor">{ymin.toFixed(1)}%</text>}
      <text x={px(xmin)} y={185} textAnchor="middle" fontSize={11} fill="currentColor">{xmin.toLocaleString('zh-CN')}</text>
      {xmax !== xmin && <text x={px(xmax)} y={185} textAnchor="end" fontSize={11} fill="currentColor">{xmax.toLocaleString('zh-CN')}</text>}
      <text x={400} y={204} textAnchor="middle" fontSize={12} fill="currentColor">净销售额（元）</text>
      {plotted.map((r, i) => <circle key={r.key} cx={px(x[i])} cy={py(y[i])} r={5} className="fill-primary stroke-background" strokeWidth={1.2}>
        <title>{r.name} · {decimalLabel(r.metrics.net_sales)} 元 · {decimalLabel(r.metrics.contribution_margin, true)}</title></circle>)}
    </svg> : <p className="my-3 text-sm">这组商品的利润率均待核算。</p>}
    <p className="text-xs text-muted-foreground">图中有 {plotted.length} 项。{rows.length - plotted.length} 项利润率待核算，仍可在明细中查看。</p>
    <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">查看销售排名和准确数值</summary>
      <div className="overflow-x-auto"><table className="mt-3 w-full text-sm"><thead><tr><th className="text-left">{DIMENSION_LABELS[dimension]}</th>
        <th className="text-right">净销售额（元）</th><th className="text-right">经营贡献利润率</th></tr></thead>
        <tbody>{rows.map((r) => <tr className="border-t border-border" key={r.key}><th className="py-2 text-left font-normal">
          <button type="button" className="text-primary hover:underline" onClick={() => select(r.key)}>{r.name}</button></th>
          <td className="text-right tabular-nums">{decimalLabel(r.metrics.net_sales)}</td>
          <td className="text-right tabular-nums">{decimalLabel(r.metrics.contribution_margin, true)}</td></tr>)}</tbody></table></div>
    </details>
  </>;
}
