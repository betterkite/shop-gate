'use client';
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BI_PANEL, BI_SELECT, BiPagination } from '@/components/bi/BiPrimitives';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { chartAxis } from '@/lib/bi/chart-axis';
import type { Overview, OverviewLocation } from '@/lib/bi/overview-contracts';
import type { OverviewNavigate } from './OverviewWorkspace';

const series = [{ key: 'net_sales', label: '净销售额', color: 'hsl(var(--primary))' },
  { key: 'accounted_contribution', label: '已核算经营贡献', color: 'hsl(32 85% 48%)' }] as const;
/** Only chart coordinates use Number; displayed values always use server decimals. */
export function OverviewTrend({ trend, page, navigate, onSelect }: {
  trend: Overview['trend']; page: number; navigate: OverviewNavigate;
  onSelect: (range: Pick<OverviewLocation, 'start' | 'end'>) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const values = trend.rows.flatMap((row) => series.flatMap(({ key }) => row.metrics?.[key] == null ? [] : [Number(row.metrics[key])])).filter(Number.isFinite);
  const { min, spread, ticks } = chartAxis(Math.min(0, ...values), Math.max(0, ...values));
  const y = (value: number) => 230 - ((value - min) / spread) * 190;
  const x = (index: number) => 72 + index * (880 / Math.max(1, trend.rows.length - 1));
  const point = trend.rows.find((row) => row.key === selected);
  const rows = trend.rows.slice((page - 1) * 20, page * 20);
  return <section className={BI_PANEL} aria-label="经营趋势">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">经营趋势</h3><p className="mt-1 text-sm text-muted-foreground">两条线使用同一金额刻度。选择日期可查看该期间，返回可恢复原范围。</p></div>
      <label className="text-sm">时间粒度 <select aria-label="趋势时间粒度" className={BI_SELECT} value={trend.interval} onChange={(e) => navigate({ interval: e.target.value as OverviewLocation['interval'], trendPage: 1 })}><option value="day">按日</option><option value="week">按周</option></select></label></div>
    <div className="mt-4 flex flex-wrap gap-5 text-xs">{series.map((entry) => <span className="flex items-center gap-2" key={entry.key}><span className="h-1 w-6 rounded" style={{ backgroundColor: entry.color }} />{entry.label}</span>)}<span className="text-muted-foreground">金额：元；缺少记录或待核算的位置留空</span></div>
    {values.length > 0 ? <div className="mt-3 overflow-hidden rounded-xl bg-muted/20">
      <svg viewBox="0 0 1000 285" className="min-h-[220px] w-full" role="img" aria-label="净销售额与已核算经营贡献趋势，具体金额见下方可分页明细">
        {ticks.map((value, index) => <g key={index}><line x1="72" x2="952" y1={y(value)} y2={y(value)} stroke="currentColor" opacity="0.1" /><text x="62" y={y(value) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.65">{new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}</text></g>)}
        <line x1="72" x2="952" y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.35" strokeDasharray="4 4" />
        {series.map((entry) => {
          let continuous = false;
          const path = trend.rows.map((row, index) => {
            const value = row.metrics?.[entry.key];
            if (value == null) { continuous = false; return ''; }
            const command = `${continuous ? 'L' : 'M'}${x(index)} ${y(Number(value))}`; continuous = true; return command;
          }).join(' ');
          return <g key={entry.key}><path d={path} fill="none" stroke={entry.color} strokeWidth="2.5" />{trend.rows.map((row, index) => row.metrics?.[entry.key] == null ? null : <circle key={row.key} cx={x(index)} cy={y(Number(row.metrics[entry.key]))} r={trend.rows.length <= 90 ? 3 : 1.5} fill={entry.color} />)}</g>;
        })}
        {trend.rows.map((row, index) => <rect key={row.key} x={x(index) - 440 / Math.max(trend.rows.length, 1)} y="25" width={Math.max(1, 880 / Math.max(trend.rows.length, 1))} height="220" fill="transparent" className="cursor-pointer" onMouseEnter={() => setSelected(row.key)} onClick={() => onSelect({ start: row.start, end: row.end })}><title>{row.start} 至 {row.end}；净销售额 {row.state === 'no_records' ? '无记录' : decimalLabel(row.metrics?.net_sales)}；已核算经营贡献 {row.state === 'no_records' ? '无记录' : decimalLabel(row.metrics?.accounted_contribution)}。点击查看该期间。</title></rect>)}
        <text x="72" y="267" fontSize="12" fill="currentColor">{trend.rows[0]?.start}</text><text x="952" y="267" textAnchor="end" fontSize="12" fill="currentColor">{trend.rows.at(-1)?.end}</text>
      </svg>
      <p className="min-h-10 px-4 pb-3 text-xs text-muted-foreground">{point ? `${point.start} 至 ${point.end}：${point.state === 'no_records' ? '没有经营记录' : `净销售额 ${decimalLabel(point.metrics?.net_sales)} 元；已核算经营贡献 ${decimalLabel(point.metrics?.accounted_contribution)} 元`}` : '将指针移到图中查看金额，也可通过下方日期按钮查看。'}</p>
    </div> : <p className="mt-5 rounded-xl bg-muted/30 p-6 text-sm text-muted-foreground">所选期间没有可绘制的已知金额，请查看数据情况。</p>}
    <details className="mt-4" open><summary className="cursor-pointer text-sm font-medium">查看全部日期与金额</summary>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="p-3">日期</th><th className="p-3 text-right">净销售额（元）</th><th className="p-3 text-right">已核算经营贡献（元）</th><th className="p-3">记录情况</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key} className="border-t border-border"><td className="p-3"><Button variant="link" className="h-auto p-0" onClick={() => onSelect({ start: row.start, end: row.end })}>{row.start}{row.start !== row.end ? ` 至 ${row.end}` : ''}</Button></td>
        {series.map(({ key }) => <td key={key} className="p-3 text-right tabular-nums">{row.state === 'no_records' ? '无记录' : decimalLabel(row.metrics?.[key])}</td>)}<td className="p-3 text-muted-foreground">{row.state === 'no_records' ? '没有经营记录' : '有经营记录'}</td></tr>)}</tbody></table></div>
      <BiPagination label="趋势日期分页" page={page} total={trend.rows.length} change={(trendPage) => navigate({ trendPage })} />
    </details><p className="mt-3 text-xs leading-6 text-muted-foreground">{trend.note}</p>
  </section>;
}
