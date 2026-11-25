'use client';
import { Button } from '@/components/ui/button';
import { BI_PANEL, BiNotice } from './BiPrimitives';
import { decimalLabel, EXPENSE_TYPE_LABELS } from '@/lib/bi/data-contracts';
import type { Overview, OverviewLocation } from '@/lib/bi/overview-contracts';

const labels = { sales_amount: '成交金额', refund_amount: '退款', product_cost: '商品成本（扣除退货冲回）', ...EXPENSE_TYPE_LABELS };
type Statement = NonNullable<Overview['profit_statement']>;
type Mode = 'current' | 'change';

function ProfitBridge({ statement, mode }: { statement: Statement; mode: Mode }) {
  const comparing = mode === 'change';
  const total = comparing ? statement.change : statement.profit;
  if (total == null || (comparing && statement.previous_profit == null)) return null;
  const start = comparing ? Number(statement.previous_profit) : 0;
  let balance = start;
  const bars = statement.rows.flatMap((row) => {
    const value = comparing ? row.change : row.amount;
    if (value == null || Number(value) === 0) return [];
    const from = balance;
    balance += Number(value);
    return [{ label: labels[row.key], value, from, to: balance }];
  });
  const all = [...(comparing ? [{ label: '上期经营贡献', value: statement.previous_profit!, from: 0, to: start }] : []),
    ...bars, { label: '本期经营贡献', value: statement.profit!, from: 0, to: Number(statement.profit) }];
  const min = Math.min(0, ...all.map((b) => Math.min(b.from, b.to)));
  const span = Math.max(0, ...all.map((b) => Math.max(b.from, b.to))) - min || 1;
  const position = (n: number) => 100 * (n - min) / span;
  return <figure aria-label={comparing ? '两期利润变化图' : '经营利润形成图'} className="my-5">
    <figcaption className="mb-3 text-sm text-muted-foreground">从上到下依次加减。条形向右增加利润，向左减少利润，金额单位为元。</figcaption>
    <ul className="space-y-2">{all.map((bar) => <li key={bar.label} className="grid grid-cols-[minmax(6rem,1fr)_2fr_minmax(5rem,auto)] items-center gap-3 text-sm">
      <span>{bar.label}</span><span aria-hidden="true" className="relative h-5 rounded-sm bg-muted/45">
        <i className="absolute inset-y-0 border-l border-border" style={{ left: position(0) + '%' }} />
        <i className={'absolute top-1 h-3 rounded-sm ' + (bar.to < bar.from ? 'bg-amber-500' : 'bg-primary')}
          style={{ left: position(Math.min(bar.from, bar.to)) + '%', width: Math.abs(bar.to - bar.from) / span * 100 + '%' }} /></span>
      <span className="text-right tabular-nums">{decimalLabel(bar.value)}</span></li>)}</ul>
  </figure>;
}

export function ProfitStatement({ data, mode = 'current', navigate }: { data: Overview; mode?: Mode; navigate: (change: Partial<OverviewLocation>) => void }) {
  const statement = data.profit_statement;
  if (data.state === 'empty') return <BiNotice>此数据集还没有可用于核算利润的经营记录。</BiNotice>;
  if (!statement) return <BiNotice error>本次数据没有返回利润明细，请刷新后重试。</BiNotice>;
  const comparable = Boolean(data.previous?.history_sufficient);
  const displayMode = comparable ? mode : 'current';
  const partial = statement.rows.some((row) => row.amount == null);
  const cards = [['经营贡献利润', statement.profit], ['已有依据的经营贡献', statement.accounted], ['已知未分摊费用', statement.unallocated]] as const;
  return <section aria-label="利润与费用核对" className={BI_PANEL}>
    <div className="grid gap-4 sm:grid-cols-3">{cards.map(([name, amount]) => <div key={name} className="min-w-0 border-l-2 border-primary/40 pl-3">
      <h3 className="text-sm text-muted-foreground">{name}</h3>
      <p className="mt-1 break-words text-xl font-semibold tabular-nums">{decimalLabel(amount)}{amount != null && ' 元'}</p></div>)}</div>
    <p className="mt-4 text-sm leading-6 text-muted-foreground">经营贡献按已接入的收入、退款、商品成本和经营费用计算。资料有缺项时，只能确认其中有依据的部分。未分摊费用已计入适用的整体或店铺范围。</p>
    <div className="mt-5 flex flex-wrap items-center gap-2"><Button size="sm" variant={displayMode === 'current' ? 'secondary' : 'outline'} aria-pressed={displayMode === 'current'} onClick={() => navigate({ profitView: 'current' })}>本期利润形成</Button>
      <Button size="sm" variant={displayMode === 'change' ? 'secondary' : 'outline'} aria-pressed={displayMode === 'change'} disabled={!comparable} onClick={() => navigate({ profitView: 'change' })}>与上期相比</Button></div>
    <p className="mt-3 text-sm">{comparable ? '上期为 ' + data.previous!.range.start + ' 至 ' + data.previous!.range.end + '。各项变化按相同天数分别核算。' : '数据集没有覆盖完整的上期日期，暂时只展示本期。'}</p>
    {displayMode === 'change' && statement.previous_profit == null && <BiNotice>上期有金额待核算。下表列出两期均有依据的变化，完整利润差额要等上期资料补齐后才能计算。</BiNotice>}
    <ProfitBridge statement={statement} mode={displayMode} />
    {statement.profit == null && <BiNotice>部分资料待补齐。可以在下表查看已有金额，再打开付款、退款或费用明细核对。</BiNotice>}
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-max text-left text-sm">
      <caption className="mb-2 text-left font-semibold">利润组成明细（元）</caption>
      <thead className="bg-muted/45"><tr>{['项目', '计入本期利润', ...(partial ? ['本期已有金额'] : []), ...(comparable ? ['上期', '对利润变化的影响'] : []), '占本期费用'].map((title) => <th key={title} className="p-2">{title}</th>)}</tr></thead>
      <tbody>{statement.rows.map((row) => <tr key={row.key} className="border-t border-border"><th scope="row" className="p-2">{labels[row.key]}</th>
        {[decimalLabel(row.amount), ...(partial ? [decimalLabel(row.known_amount)] : []),
          ...(comparable ? [decimalLabel(row.previous), decimalLabel(row.change)] : []), row.fee_share == null ? '—' : decimalLabel(row.fee_share, true)].map((cell, i) =>
          <td key={i} className="p-2 text-right tabular-nums">{cell}</td>)}</tr>)}</tbody>
      <tfoot><tr className="border-t border-border font-semibold"><th className="p-2">经营贡献利润</th><td className="p-2 text-right">{decimalLabel(statement.profit)}</td>{partial && <td />}
        {comparable && <><td className="p-2 text-right">{decimalLabel(statement.previous_profit)}</td>
          <td className="p-2 text-right">{decimalLabel(statement.change)}</td></>}<td /></tr></tfoot>
    </table></div>
    <div className="mt-4 flex flex-wrap gap-2">{([['sale', '查看付款'], ['refund', '查看退款'], ['expense', '查看费用归属']] as const).map(([kind, title]) =>
      <Button key={kind} variant="outline" size="sm" onClick={() => navigate({ sourceKind: kind })}>{title}</Button>)}</div>
  </section>;
}
