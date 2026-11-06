'use client';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { BiNotice, BiPagination } from './BiPrimitives';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { agentChartSchema, AGENT_METRIC_LABELS, readAgent } from '@/lib/bi/agent/browser';
import type { BiAgentAnswerContent } from '@/lib/bi/agent/result-contracts';
import { chartSeries } from '@/lib/bi/agent/chart-series';

export function BiAssistantChart({ workspaceId, datasetId, version, runId, view }: {
  workspaceId: string; datasetId: string; version: number; runId: string; view: BiAgentAnswerContent['views'][number];
}) {
  const [data, setData] = useState<z.infer<typeof agentChartSchema> | null>(null);
  const [error, setError] = useState(''), [page, setPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setPage(1);
    readAgent({ action: 'chart', workspace_id: workspaceId, run_id: runId, result_id: view.result_id }, agentChartSchema, { signal: controller.signal })
      .then((value) => {
        if (value.evidence_id !== view.result_id || value.metadata.workspace_id !== workspaceId || value.metadata.dataset_id !== datasetId
          || value.metadata.version !== version || !value.query.metrics.includes(view.metric)
          || (view.kind === 'line' && !['day', 'week'].includes(value.query.dimension))) throw new Error('图表依据的范围或版本不一致。');
        if (!controller.signal.aborted) setData(value);
      }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '图表暂不可用。'); });
    return () => controller.abort();
  }, [workspaceId, datasetId, version, runId, view.result_id, view.metric, view.kind]);
  if (error) return <BiNotice error>{error} 答案和下方完整依据仍可查看。</BiNotice>;
  if (!data) return <p role="status" className="text-sm text-muted-foreground">正在读取完整图表依据…</p>;
  if (data.state === 'table_only') return <BiNotice>共有 {data.total} 项，逐项绘图过于密集。请通过下方依据表查看全部记录；答案不受影响。</BiNotice>;
  const series = chartSeries(data.rows, view.metric, view.kind === 'line', data.query.dimension === 'week' ? 7 : 1);
  const { rows, min, max } = series, spread = max - min || 1;
  if (!rows.some((r) => r.value !== null)) return <BiNotice>没有可绘制的已知数值。缺失值未按零绘制，请查看下方依据。</BiNotice>;
  const metric = AGENT_METRIC_LABELS[view.metric], percent = view.metric.endsWith('_ratio') || view.metric === 'contribution_margin';
  const label = (r: typeof rows[number]) => `${r.name}：${decimalLabel(r.raw, percent)}`;
  const visible = view.kind === 'bar' ? rows.slice((page - 1) * 20, page * 20) : rows;
  const y = (v: number) => 230 - (v - min) / spread * 190;
  const x = (i: number) => 72 + i * 880 / Math.max(1, rows.length - 1);
  const barX = (v: number) => 230 + (v - min) / spread * 650;
  let continuous = false;
  const path = rows.map((r, i) => {
    if (r.value === null) { continuous = false; return ''; }
    const segment = `${continuous && !r.gapBefore ? 'L' : 'M'}${x(i)} ${y(r.value)}`; continuous = true; return segment;
  }).join(' ');
  return <section className="rounded-xl border border-border bg-muted/10 p-4" aria-label={`${metric}分析图表`}>
    <h4 className="font-medium">{metric}</h4>
    <p className="mt-2 text-xs leading-6 text-muted-foreground">数据版本 {version} · {data.metadata.range.start ?? '无日期'} 至 {data.metadata.range.end ?? '无日期'} · 共 {data.total} 项。{view.kind === 'bar' ? `当前展示第 ${(page - 1) * 20 + 1}–${Math.min(page * 20, rows.length)} 项，刻度按全部记录确定。` : '按时间排列全部记录，缺失值及无记录日期不连线。'} 原始精确数值见下方依据表。</p>
    <div className="mt-3 overflow-x-auto">
      <svg viewBox={`0 0 1024 ${view.kind === 'bar' ? 45 + visible.length * 32 : 280}`} className="w-full min-w-[640px]" role="img" aria-label={`${metric}；${view.kind === 'bar' ? '当前页对比' : '完整期间趋势'}，可核对下方依据表`}>
        {view.kind === 'bar' ? <>
          <line x1={barX(0)} x2={barX(0)} y1="25" y2={30 + visible.length * 32} stroke="currentColor" opacity="0.4" />
          {[min, max].map((v, i) => <text key={i} x={barX(v)} y="15" fontSize="11" textAnchor={i ? 'end' : 'start'} fill="currentColor">{v}</text>)}
          {visible.map((r, i) => <g key={r.key}>
            <text x="215" y={49 + i * 32} textAnchor="end" fontSize="12" fill="currentColor">{r.name.length > 18 ? `${r.name.slice(0, 18)}…` : r.name}<title>{r.name}</title></text>
            {r.value !== null && <rect x={Math.min(barX(0), barX(r.value))} y={32 + i * 32} width={Math.max(1, Math.abs(barX(r.value) - barX(0)))} height="23" rx="3" fill="hsl(var(--primary))"><title>{label(r)}</title></rect>}
            <text x="895" y={49 + i * 32} fontSize="12" fill="currentColor">{decimalLabel(r.raw, percent)}</text>
          </g>)}
        </> : <>
          {[min, min + spread / 2, max].map((v, i) => <g key={i}><line x1="72" x2="952" y1={y(v)} y2={y(v)} stroke="currentColor" opacity="0.15" /><text x="62" y={y(v) + 4} textAnchor="end" fontSize="11" fill="currentColor">{new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(v)}</text></g>)}
          <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" />
          {rows.map((r, i) => r.value === null ? null : <circle key={r.key} cx={x(i)} cy={y(r.value)} r={rows.length <= 90 ? 3 : 1.5} fill="hsl(var(--primary))"><title>{label(r)}</title></circle>)}
          <text x="72" y="267" fontSize="12" fill="currentColor">{rows[0]?.name}</text><text x="952" y="267" textAnchor="end" fontSize="12" fill="currentColor">{rows.at(-1)?.name}</text>
        </>}
      </svg>
    </div>
    {view.kind === 'bar' && <BiPagination label={`${metric}图表分页`} page={page} total={rows.length} change={setPage} />}
  </section>;
}
