import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  getCommercePlatformData,
  displayNumber,
  displayMoney,
  displayPercent,
  COMMERCE_PLATFORM_SORTS,
  type CommercePlatformView,
} from '@/lib/commerce/commerce-platform';
import { RetailPageShell } from '@/components/layout/RetailPageShell';

export const metadata: Metadata = {
  title: '商品运营 · Shop Gate',
  description: '商品池、类目结构与渠道经营分析。',
};

export const dynamic = 'force-dynamic';

type Props = { searchParams?: Promise<{ view?: string; page?: string; sort?: string }> };

const VIEW_LABELS: Record<CommercePlatformView, string> = {
  products: '商品池',
  categories: '品类池',
  channels: '渠道分析',
};

const SORT_LABELS: Record<string, string> = {
  gmv: '成交总额（GMV）',
  pv: '页面浏览量（PV）',
  buy: '购买（Buy）',
  price: '价格',
};

function tabHref(view: CommercePlatformView, currentSort: string): string {
  return `/commerce-platform?view=${view}&sort=${currentSort}`;
}

function SyntheticBadge() {
  return (
    <span
      className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
      title="商品价格、库存、渠道和成交金额使用演示数据，不代表真实订单金额"
    >
      演示数据
    </span>
  );
}

function Cell({ value, className = '' }: { value: string; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-3 text-sm ${className}`}>{value}</td>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </article>
  );
}

function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm">
      <table className="min-w-[820px] divide-y divide-border/70">{children}</table>
    </div>
  );
}

export default async function CommercePlatformPage({ searchParams }: Props) {
  const params = await searchParams;
  const data = await getCommercePlatformData({
    view: params?.view,
    page: params?.page,
    sort: params?.sort,
  });
  const { view, window: win } = data;
  const totals = data.summary?.totals as Record<string, unknown> | undefined;
  const tabs = (Object.keys(VIEW_LABELS) as CommercePlatformView[]).map((key) => ({
    href: tabHref(key, data.sort),
    label: VIEW_LABELS[key],
    active: view === key,
  }));
  const sortLinks = COMMERCE_PLATFORM_SORTS.map((sort) => (
    <Link
      key={sort}
      href={`/commerce-platform?view=products&page=1&sort=${sort}`}
      prefetch={false}
      className={data.sort === sort
        ? 'rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground'
        : 'rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground'}
    >
      按 {SORT_LABELS[sort] ?? sort}
    </Link>
  ));

  return (
    <RetailPageShell
      title="商品运营"
      subtitle={`窗口 ${win.start} ~ ${win.end} · ${data.behaviorSource === 'synthetic' ? '演示行为数据' : '真实用户行为数据'}`}
      badge={<SyntheticBadge />}
      tabs={tabs}
    >
      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Metric label="成交总额（GMV）" value={displayMoney(totals?.gmv)} hint="按购买次数 × 商品价格估算" />
        <Metric label="页面浏览量（PV）" value={displayNumber(totals?.pv, 0)} hint="打开商品页面的次数" />
        <Metric label="独立访客（UV）" value={displayNumber(totals?.uv, 0)} hint="看过商品页面的不同用户数" />
        <Metric label="购买次数" value={displayNumber(totals?.buy, 0)} hint="商品被买下的次数" />
        <Metric label="购买转化率" value={displayPercent(data.summary?.buy_conversion)} hint="购买次数 ÷ 页面浏览量" />
        <Metric label="平均每次购买金额" value={displayMoney(data.summary?.avg_price)} hint="成交总额 ÷ 购买次数（估算）" />
      </section>

      {!data.apiEnabled ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">commerce-data API 已按降级配置停用，无法读取数据。</p>
      ) : view === 'products' ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">商品表现与转化</h2>
              <p className="mt-1 text-sm text-muted-foreground">先定位成交总额（GMV）和流量贡献，再结合库存与转化决定动作。</p>
            </div>
            <div className="flex flex-wrap gap-2">{sortLinks}</div>
          </div>
          <DataTable>
            <thead className="bg-muted/60">
              <tr className="text-left text-xs font-semibold text-muted-foreground">
                {['商品', '类目', '店铺', '渠道', '价格', '库存', '页面浏览量（PV）', '购买', '成交总额（GMV）', '转化率'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((item, index) => (
                <tr key={String(item.item_id ?? index)} className="hover:bg-muted/35">
                  <Cell value={String(item.title ?? '-')} className="max-w-[240px] truncate font-medium" />
                  <Cell value={String(item.category_name ?? '-')} />
                  <Cell value={String(item.shop_name ?? '-')} />
                  <Cell value={String(item.shop_tier ?? '-')} />
                  <Cell value={displayMoney(item.price)} />
                  <Cell value={displayNumber(item.stock, 0)} />
                  <Cell value={displayNumber(item.pv, 0)} />
                  <Cell value={displayNumber(item.buy, 0)} />
                  <Cell value={displayMoney(item.gmv)} className="font-semibold" />
                  <Cell value={displayPercent(item.buy_conversion)} />
                </tr>
              ))}
            </tbody>
          </DataTable>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>共 {displayNumber(data.itemsTotal, 0)} 个商品 · 第 {data.page} 页（每页 {data.pageSize}）</span>
            <span className="flex gap-2">
              {data.page > 1 ? <Link href={`/commerce-platform?view=products&page=${data.page - 1}&sort=${data.sort}`} className="rounded-lg bg-muted px-3 py-1.5">上一页</Link> : null}
              {data.page * data.pageSize < data.itemsTotal ? <Link href={`/commerce-platform?view=products&page=${data.page + 1}&sort=${data.sort}`} className="rounded-lg bg-muted px-3 py-1.5">下一页</Link> : null}
            </span>
          </div>
        </section>
      ) : view === 'categories' ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">类目贡献与集中度</h2>
            <p className="mt-1 text-sm text-muted-foreground">用成交总额（GMV）、页面浏览量（PV）和转化率同时看结构，避免只追逐单一规模指标。</p>
          </div>
          <DataTable>
            <thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground">{['#', '类目', '页面浏览量（PV）', '购买', '成交总额（GMV）', '转化率', '客单价'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border/60">{data.categories.map((cat, index) => <tr key={String(cat.category_id ?? index)} className="hover:bg-muted/35"><Cell value={String(index + 1)} /><Cell value={String(cat.category_name ?? '-')} className="font-medium" /><Cell value={displayNumber(cat.pv, 0)} /><Cell value={displayNumber(cat.buy, 0)} /><Cell value={displayMoney(cat.gmv)} className="font-semibold" /><Cell value={displayPercent(cat.buy_conversion)} /><Cell value={displayMoney(cat.avg_price)} /></tr>)}</tbody>
          </DataTable>
          <p className="text-xs text-muted-foreground">类目名称来自演示数据；成交总额按购买次数 × 商品价格估算。</p>
        </section>
      ) : (
        <section className="space-y-4">
          <div><h2 className="text-lg font-semibold">渠道贡献与店铺层级</h2><p className="mt-1 text-sm text-muted-foreground">比较不同店铺类型的浏览量、购买和成交总额贡献。</p></div>
          <div className="grid gap-4 md:grid-cols-2">
            {data.channels.map((channel) => {
              const totalGmv = data.channels.reduce((sum, row) => sum + (Number(row.gmv) || 0), 0);
              const gmvShare = totalGmv > 0 ? (Number(channel.gmv) || 0) / totalGmv : 0;
              return <article key={String(channel.channel)} className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{String(channel.channel ?? '-')}</h3><span className="text-xs text-muted-foreground">{displayPercent(gmvShare)} 成交总额（GMV）占比</span></div><div className="my-4 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(1, gmvShare * 100).toFixed(1)}%` }} /></div><dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">店铺数</dt><dd className="text-right">{displayNumber(channel.shop_count, 0)}</dd><dt className="text-muted-foreground">商品数</dt><dd className="text-right">{displayNumber(channel.item_count, 0)}</dd><dt className="text-muted-foreground">页面浏览量（PV）</dt><dd className="text-right">{displayNumber(channel.pv, 0)}</dd><dt className="text-muted-foreground">购买</dt><dd className="text-right">{displayNumber(channel.buy, 0)}</dd><dt className="text-muted-foreground">成交总额（GMV）</dt><dd className="text-right font-semibold">{displayMoney(channel.gmv)}</dd></dl></article>;
            })}
          </div>
          <p className="text-xs text-muted-foreground">渠道按店铺类型划分；行为数据用于统计浏览和购买，成交总额按商品价格估算。</p>
        </section>
      )}
    </RetailPageShell>
  );
}
