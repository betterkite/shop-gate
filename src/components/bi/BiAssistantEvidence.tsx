import React from 'react';
import type { z } from 'zod';
import { decimalLabel } from '@/lib/bi/data-contracts';
import { DIMENSION_LABELS } from '@/lib/bi/overview-contracts';
import { AGENT_METRIC_LABELS, type agentResultSchema } from '@/lib/bi/agent/browser';
import type { definitionEvidenceSchema } from '@/lib/bi/agent/metric-contracts';

export function BiDefinitionEvidence({ evidence, open, onOpenChange }: { evidence: z.infer<typeof definitionEvidenceSchema>; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const dimensions: Record<string, string> = { overall: '全部范围', ...DIMENSION_LABELS };
  return <details className="rounded-lg border border-border p-3" open={open}><summary onClick={onOpenChange ? (event) => { event.preventDefault(); onOpenChange(!open); } : undefined} className="cursor-pointer text-sm font-medium">查看指标说明依据</summary>
    <p className="mt-3 text-xs text-muted-foreground">来自系统指标说明，保留回答时的版本。记录时间：{evidence.recorded_at.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}。</p>
    {evidence.metrics.map((metric) => <section key={metric.id} className="mt-4 space-y-2 text-sm">
      <h4 className="font-medium">{metric.name}</h4><dl className="space-y-2">
        {[['计算方法', metric.formula], ['单位', metric.unit], ['缺少数据时', metric.missing_policy],
          ['数据来源', metric.source], ['汇总方式', metric.aggregation],
          ['可查看范围', metric.dimensions.map((dimension) => dimensions[dimension] ?? '其他范围').join('、')]]
          .filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd></div>)}
      </dl></section>)}
  </details>;
}

export function BiEvidenceTable({ data }: { data: z.infer<typeof agentResultSchema> }) {
  if (data.total === 0) return <p className="mt-3 text-sm text-muted-foreground">此范围没有符合条件的记录。</p>;
  if (data.rows.length === 0) return <p className="mt-3 text-sm text-muted-foreground">此页没有记录，请选择其他页码。</p>;
  return <div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr>
    <th className="min-w-36 whitespace-nowrap p-2 text-left">对象 / 日期</th>
    {data.query.metrics.map((m) => <th key={m} className="whitespace-nowrap p-2 text-right">{AGENT_METRIC_LABELS[m]}</th>)}
  </tr></thead><tbody>{data.rows.map((r) => <tr key={r.key} className="border-t border-border"><td className="min-w-36 p-2">{r.name}</td>
    {data.query.metrics.map((m) => <td key={m} className="whitespace-nowrap p-2 text-right tabular-nums">{decimalLabel(r.metrics[m], ['contribution_margin', 'refund_ratio', 'coverage_ratio'].includes(m))}</td>)}
  </tr>)}</tbody></table></div>;
}
