'use client';

import React from 'react';
import Link from 'next/link';
import { BI_PANEL, BI_SELECT, BiPagination } from '@/components/bi/BiPrimitives';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { sectionHref, type Overview, type OverviewLocation } from '@/lib/bi/overview-contracts';
import { chartAxis } from '@/lib/bi/chart-axis';

const labels = {
  net_sales: '净销售额', contribution_profit: '经营贡献利润',
  contribution_margin: '经营贡献利润率', refund_ratio: '退款金额占比',
} as const;
const palette = ['#0284c7', '#d97706', '#059669', '#a855f7', '#e11d48', '#64748b'];

/** The table uses original decimals. Only plot coordinates are floats. */
export function ChannelTrends({ data, location, navigate }: {
  data: NonNullable<Overview['channel_trends']>; location: OverviewLocation;
  navigate: (change: Partial<OverviewLocation>) => void;
}) {
  const metric = location.channelTrendMetric ?? 'net_sales';
  const ratio = metric === 'refund_ratio' || metric === 'contribution_margin';
  const values = data.channels.flatMap((channel) => channel.points.flatMap((point) =>
    point?.[metric] == null ? [] : [Number(point[metric]) * (ratio ? 100 : 1)]));
  const axis = chartAxis(Math.min(0, ...values), Math.max(0, ...values));
  const x = (i: number) => 65 + i * 800 / Math.max(1, data.periods.length - 1);
  const y = (value: number) => 210 - (value - axis.min) / axis.spread * 175;
  const link = (channel: string, period: { start: string; end: string }) =>
    sectionHref('stores', { ...location, channelId: channel, start: period.start, end: period.end });
  return <section className={BI_PANEL} aria-label="渠道趋势对比">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h3 className="text-lg font-semibold">渠道趋势对比</h3>
      <label className="grid gap-1 text-sm">对比指标<select className={BI_SELECT} value={metric}
        onChange={(event) => navigate({ channelTrendMetric: event.target.value as keyof typeof labels })}>
        {Object.entries(labels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="grid gap-1 text-sm">时间粒度<select value={location.interval} className={BI_SELECT}
        onChange={(event) => navigate({ interval: event.target.value as 'day' | 'week' })}>
        <option value="day">按日</option><option value="week">按周</option></select></label>
    </div>
    <p className="my-3 text-sm text-muted-foreground">每条线代表一个销售平台。点击数据点或表格中的金额，可查看该期间的店铺记录，浏览器返回可恢复当前位置。</p>
    <ul className="mb-2 flex flex-wrap gap-4 text-sm">{data.channels.map((c, i) => <li key={c.key} className="inline-flex items-center gap-2">
      <i aria-hidden="true" className="h-2 w-4 rounded-sm" style={{ backgroundColor: palette[i % palette.length] }} />{c.name}</li>)}</ul>
    {values.length ? <svg className="w-full" viewBox="0 0 920 250" role="img" aria-label={labels[metric] + '分平台趋势图'}>
      {axis.ticks.map((tick) => <g key={tick}><line x1="65" x2="865" y1={y(tick)} y2={y(tick)} stroke="currentColor" opacity=".15"/>
        <text x="60" y={y(tick) + 4} textAnchor="end" fill="currentColor" fontSize="12">{tick.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}{ratio ? '%' : '元'}</text></g>)}
      {data.channels.map((channel, i) => {
        let connected = false;
        const color = palette[i % palette.length];
        const path = channel.points.map((point, index) => {
          const v = point?.[metric];
          if (v == null) { connected = false; return ''; }
          const command = connected ? 'L' : 'M'; connected = true;
          return command + x(index) + ' ' + y(Number(v) * (ratio ? 100 : 1));
        }).join(' ');
        return <g key={channel.key}><path d={path} fill="none" stroke={color} strokeWidth="2.5"/>
          {channel.points.map((point, index) => {
            const value = point?.[metric]; if (value == null) return null;
            const dot = <circle cx={x(index)} cy={y(Number(value) * (ratio ? 100 : 1))} r="4" fill={color}>
              <title>{channel.name} · {data.periods[index].start} · {decimalLabel(value, ratio)}</title></circle>;
            return channel.key === '__unattributed__' ? <g key={index}>{dot}</g> :
              <a key={index} href={link(channel.key, data.periods[index])}>{dot}</a>;
          })}</g>;
      })}
      <text x="65" y="238" fill="currentColor" fontSize="12">{data.periods[0]?.start}</text>
      <text x="865" y="238" textAnchor="end" fill="currentColor" fontSize="12">{data.periods.at(-1)?.end}</text>
    </svg> : <p className="my-4 text-sm text-muted-foreground">当前所选期间没有可绘制的数值，可在表格中查看原因。</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-max text-sm">
      <caption className="text-left text-sm font-medium">{labels[metric]}（{ratio ? '%' : '元'}）</caption>
      <thead><tr><th className="p-2 text-left">日期</th>{data.channels.map((c) => <th key={c.key} className="p-2 text-right">{c.name}</th>)}</tr></thead>
      <tbody>{data.periods.map((period, i) => <tr key={period.key} className="border-t border-border">
        <th className="p-2 text-left">{period.start}{period.end !== period.start && ' 至 ' + period.end}</th>
        {data.channels.map((channel) => {
          const point = channel.points[i];
          const value = point?.[metric];
          const label = !point ? '没有经营记录' : value == null ? '依据不足' : decimalLabel(value, ratio);
          return <td key={channel.key} className="p-2 text-right tabular-nums">{!point || channel.key === '__unattributed__' ? label :
            <Link href={link(channel.key, period)} className="text-primary underline">{label}</Link>}</td>;
        })}</tr>)}</tbody></table></div>
    {metric === 'refund_ratio' && <p className="mt-2 text-xs text-muted-foreground">按原订单付款日期且有成交金额时可以计算退款占比。</p>}
    <BiPagination label="渠道趋势日期分页" page={data.period_page} total={data.period_total} change={(trendPage) => navigate({ trendPage })}/>
    {data.channel_total > 20 && <BiPagination label="趋势平台分页" page={data.channel_page} total={data.channel_total} change={(channelPage) => navigate({ channelPage })}/>}
  </section>;
}
