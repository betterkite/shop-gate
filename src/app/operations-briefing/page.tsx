import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOperationsBriefingData, type OperationsBriefingView } from '@/lib/commerce/retail-briefing';
import { displayNumber, displayMoney, displayPercent } from '@/lib/commerce/commerce-platform';
import { RetailPageShell } from '@/components/layout/RetailPageShell';
import { GenerateDailyBriefButton } from './GenerateDailyBriefButton';

export const metadata: Metadata = {
  title: '经营情报 · Shop Gate',
  description: '经营日报、类目经营榜与观察池（真实行为 + 合成金额口径）。',
};

export const dynamic = 'force-dynamic';

type Props = { searchParams?: Promise<{ view?: string }> };

const VIEW_LABELS: Record<OperationsBriefingView, string> = {
  daily: '经营日报',
  categories: '类目经营榜',
  watch: '观察池',
};

const METRIC_LABELS: Record<string, string> = {
  gmv: '成交总额（GMV）',
  pv: '页面浏览量（PV）',
  uv: '独立访客（UV）',
  fav: '收藏（Fav）',
  cart: '加购（Cart）',
  buy: '购买（Buy）',
  buyers: '购买用户数',
};

function SyntheticBadge() {
  return <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">合成口径</span>;
}

function Cell({ value, className = '' }: { value: string; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-3 text-sm ${className}`}>{value}</td>;
}

function DataTable({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm"><table className="min-w-[720px] divide-y divide-border/70">{children}</table></div>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p><p className="mt-1 text-xs text-muted-foreground">{hint}</p></article>;
}

export default async function OperationsBriefingPage({ searchParams }: Props) {
  const params = await searchParams;
  const data = await getOperationsBriefingData({ view: params?.view });
  const { view } = data;
  const totals = data.daily?.totals as Record<string, unknown> | undefined;
  const dayOverDay = data.daily?.day_over_day as Record<string, unknown> | undefined;
  const topCategory = data.categories[0];
  const topWatch = data.watch[0];
  const tabs = (Object.keys(VIEW_LABELS) as OperationsBriefingView[]).map((key) => ({
    href: `/operations-briefing?view=${key}`,
    label: VIEW_LABELS[key],
    active: view === key,
  }));

  return (
    <RetailPageShell
      title="经营情报"
      subtitle={`窗口 ${data.window.start} ~ ${data.window.end} · 行为源 ${data.behaviorSource} · ${data.behaviorSource === 'synthetic' ? '合成演示数据' : '真实行为流'}`}
      badge={<SyntheticBadge />}
      tabs={tabs}
    >
      {!data.apiEnabled ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">commerce-data API 已按降级配置停用，无法读取数据。</p>
      ) : view === 'daily' ? (
        <section className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
            <div><p className="text-sm font-semibold">{String(data.daily?.stat_date ?? data.window.end)} 经营日报</p><p className="mt-1 text-xs text-muted-foreground">先看结果，再顺着环比和类目拆解找行动点。</p></div>
            <div className="flex flex-wrap items-center gap-3"><GenerateDailyBriefButton /><span className="text-sm text-muted-foreground">最近生成：{data.latestReport ? new Intl.DateTimeFormat('zh-CN').format(new Date(data.latestReport.date)) : '尚未生成'}</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Metric label="成交总额（GMV）" value={displayMoney(totals?.gmv)} hint="合成金额口径" />
            <Metric label="页面浏览量（PV）" value={displayNumber(totals?.pv, 0)} hint="真实行为事件" />
            <Metric label="独立访客（UV）" value={displayNumber(totals?.uv, 0)} hint="按用户去重" />
            <Metric label="购买事件" value={displayNumber(totals?.buy, 0)} hint="真实行为事件" />
            <Metric label="购买转化率" value={displayPercent(data.daily?.buy_conversion)} hint="购买事件 / 页面浏览量" />
            <Metric label="客单价" value={displayMoney(data.daily?.avg_price)} hint="合成价格口径" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <section className="min-w-0 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">异常与趋势信号</h2><p className="mt-1 text-xs text-muted-foreground">以日环比识别需要进一步拆解的指标。</p></div><span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{String(data.daily?.status ?? 'ok')}</span></div>
              <DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">指标</th><th className="px-3 py-3">日环比</th><th className="px-3 py-3">判断</th></tr></thead><tbody className="divide-y divide-border/60">{dayOverDay ? Object.entries(dayOverDay).map(([key, value]) => { const n = Number(value); const label = n < 0 ? '需要拆解' : n > 0 ? '正向变化' : '保持稳定'; return <tr key={`dod-${key}`} className="hover:bg-muted/35"><Cell value={METRIC_LABELS[key] ?? key} className="font-medium" /><Cell value={value === null ? '-' : displayPercent(value)} /><Cell value={label} className={n < 0 ? 'text-rose-600' : 'text-emerald-600'} /></tr>; }) : <tr><Cell value="首日或无前日数据，不计算日环比。" /></tr>}</tbody></DataTable>
            </section>
            <section className="min-w-0 rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><h2 className="font-semibold">重点关注</h2><div className="mt-4 space-y-4 text-sm"><div><p className="text-xs text-muted-foreground">成交总额（GMV）贡献最高类目</p><p className="mt-1 font-semibold">{String(topCategory?.category_name ?? '暂无')}</p><p className="mt-1 text-xs text-muted-foreground">{topCategory ? `${displayMoney(topCategory.gmv)} · 转化 ${displayPercent(topCategory.buy_conversion)}` : '暂无可用类目数据'}</p></div><div className="border-t border-border/60 pt-4"><p className="text-xs text-muted-foreground">观察池头部商品</p><p className="mt-1 truncate font-semibold">{String(topWatch?.title ?? '暂无')}</p><p className="mt-1 text-xs text-muted-foreground">{topWatch ? `${displayMoney(topWatch.gmv)} · 购买 ${displayNumber(topWatch.buy, 0)}` : '暂无可用商品数据'}</p></div><div className="border-t border-border/60 pt-4"><p className="text-xs text-muted-foreground">建议动作</p><p className="mt-1 font-medium">{dayOverDay && Object.values(dayOverDay).some((value) => Number(value) < 0) ? '下钻负向指标，优先检查对应类目与商品转化。' : '继续观察头部类目，同时复核库存和价格带。'}</p></div></div></section>
          </div>
          <p className="text-xs text-muted-foreground">日报描述窗口末日快照和可计算的环比，不推断窗口外趋势；GMV/客单价为合成口径。</p>
        </section>
      ) : view === 'categories' ? (
        <section className="space-y-4"><div><h2 className="text-lg font-semibold">类目经营榜</h2><p className="mt-1 text-sm text-muted-foreground">用规模、转化和客单价定位增长类目与结构风险。</p></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground">{['#', '类目', '页面浏览量（PV）', '购买', '成交总额（GMV）', '转化率', '客单价'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}</tr></thead><tbody className="divide-y divide-border/60">{data.categories.map((cat, index) => <tr key={String(cat.category_id ?? index)} className="hover:bg-muted/35"><Cell value={String(index + 1)} /><Cell value={String(cat.category_name ?? '-')} className="font-medium" /><Cell value={displayNumber(cat.pv, 0)} /><Cell value={displayNumber(cat.buy, 0)} /><Cell value={displayMoney(cat.gmv)} className="font-semibold" /><Cell value={displayPercent(cat.buy_conversion)} /><Cell value={displayMoney(cat.avg_price)} /></tr>)}</tbody></DataTable><p className="text-xs text-muted-foreground">类目名为合成映射；成交总额（GMV）= 购买事件 × 合成价格。</p></section>
      ) : (
        <section className="space-y-4"><div><h2 className="text-lg font-semibold">观察池</h2><p className="mt-1 text-sm text-muted-foreground">窗口内成交总额（GMV）领先商品，用于后续库存、价格和转化复核。</p></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground">{['商品', '类目', '渠道', '价格', '页面浏览量（PV）', '购买', '成交总额（GMV）', '转化率'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}</tr></thead><tbody className="divide-y divide-border/60">{data.watch.map((item, index) => <tr key={String(item.item_id ?? index)} className="hover:bg-muted/35"><Cell value={String(item.title ?? '-')} className="max-w-[260px] truncate font-medium" /><Cell value={String(item.category_name ?? '-')} /><Cell value={String(item.shop_tier ?? '-')} /><Cell value={displayMoney(item.price)} /><Cell value={displayNumber(item.pv, 0)} /><Cell value={displayNumber(item.buy, 0)} /><Cell value={displayMoney(item.gmv)} className="font-semibold" /><Cell value={displayPercent(item.buy_conversion)} /></tr>)}</tbody></DataTable><p className="text-xs text-muted-foreground">观察池=窗口内成交总额（GMV）领先商品（top-20）；价格/渠道/成交总额为合成口径。</p></section>
      )}
    </RetailPageShell>
  );
}
