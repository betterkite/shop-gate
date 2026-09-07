import type { Metadata } from 'next';
import Link from 'next/link';
import {
  getCommercePlatformData,
  isCommercePlatformSort,
  displayNumber,
  displayMoney,
  displayPercent,
  COMMERCE_PLATFORM_SORTS,
  type CommercePlatformView,
} from '@/lib/commerce/commerce-platform';

export const metadata: Metadata = {
  title: '商品运营 · Shop Gate',
  description: '商品池、类目结构与渠道（店铺 tier）经营分析。',
};

export const dynamic = 'force-dynamic';

type Props = { searchParams?: Promise<{ view?: string; page?: string; sort?: string }> };

const VIEW_LABELS: Record<CommercePlatformView, string> = {
  products: '商品池',
  categories: '品类池',
  channels: '渠道分析',
};

function tabHref(view: CommercePlatformView, currentSort: string): string {
  return `/commerce-platform?view=${view}&sort=${currentSort}`;
}

function SyntheticBadge() {
  return (
    <span
      className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      title="价格/库存/品牌/店铺与 GMV 金额来自合成主数据，不代表真实交易数据"
    >
      合成口径
    </span>
  );
}

function Cell({ value, className }: { value: string; className?: string }) {
  return <td className={`px-3 py-2 text-sm ${className ?? ''}`}>{value}</td>;
}

export default async function CommercePlatformPage({ searchParams }: Props) {
  const params = await searchParams;
  const data = await getCommercePlatformData({
    view: params?.view,
    page: params?.page,
    sort: params?.sort,
  });

  const { view, window: win, behaviorSource } = data;
  const sortLinks = COMMERCE_PLATFORM_SORTS.map((sort) => (
    <Link
      key={sort}
      href={`/commerce-platform?view=products&page=1&sort=${sort}`}
      className={`rounded px-2 py-1 text-xs ${
        data.sort === sort ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800'
      }`}
      prefetch={false}
    >
      {sort}
    </Link>
  ));

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">商品运营</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          商品池、类目结构与渠道（店铺 tier）经营分析——窗口 {win.start} ~ {win.end}；行为流来源{' '}
          <span className="font-mono">{behaviorSource}</span>
          {data.behaviorSource === 'synthetic' ? '（合成演示数据）' : '（真实行为流）'}
        </p>
        <div className="mt-2">{<SyntheticBadge />}</div>
      </header>

      <nav className="mb-6 flex gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
        {(Object.keys(VIEW_LABELS) as CommercePlatformView[]).map((key) => (
          <Link
            key={key}
            href={tabHref(key, data.sort)}
            prefetch={false}
            className={`rounded-md px-3 py-2 text-sm font-medium ${
              view === key
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
            }`}
          >
            {VIEW_LABELS[key]}
          </Link>
        ))}
      </nav>

      {!data.apiEnabled ? (
        <p className="text-sm text-red-500">commerce-data API 已按降级配置停用，无法读取数据。</p>
      ) : view === 'products' ? (
        <section>
          <div className="mb-3 flex items-center gap-2">{sortLinks}</div>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {['商品', '类目', '店铺', '渠道', '价格', '库存', '曝光', '购买', 'GMV', '转化'].map((h) => (
                    <th key={h} className="px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((item, index) => (
                  <tr key={String(item.item_id ?? index)} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Cell value={String(item.title ?? '-')} />
                    <Cell value={String(item.category_name ?? '-')} />
                    <Cell value={String(item.shop_name ?? '-')} />
                    <Cell value={String(item.shop_tier ?? '-')} />
                    <Cell value={displayMoney(item.price)} />
                    <Cell value={displayNumber(item.stock, 0)} />
                    <Cell value={displayNumber(item.pv, 0)} />
                    <Cell value={displayNumber(item.buy, 0)} />
                    <Cell value={displayMoney(item.gmv)} />
                    <Cell value={displayPercent(item.buy_conversion)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
            <span>
              共 {displayNumber(data.itemsTotal, 0)} 个商品 · 第 {data.page} 页（每页 {data.pageSize}）
            </span>
            <span className="flex gap-2">
              {data.page > 1 ? (
                <Link
                  href={`/commerce-platform?view=products&page=${data.page - 1}&sort=${data.sort}`}
                  className="rounded bg-slate-100 px-3 py-1 dark:bg-slate-800"
                  prefetch={false}
                >
                  上一页
                </Link>
              ) : null}
              {data.page * data.pageSize < data.itemsTotal ? (
                <Link
                  href={`/commerce-platform?view=products&page=${data.page + 1}&sort=${data.sort}`}
                  className="rounded bg-slate-100 px-3 py-1 dark:bg-slate-800"
                  prefetch={false}
                >
                  下一页
                </Link>
              ) : null}
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-400">价格/库存/品牌/店铺与 GMV 为合成主数据口径。</p>
        </section>
      ) : view === 'categories' ? (
        <section>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {['#', '类目', '曝光', '购买', 'GMV', '转化率', '客单价'].map((h) => (
                    <th key={h} className="px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.categories.map((cat, index) => (
                  <tr key={String(cat.category_id ?? index)} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Cell value={String(index + 1)} />
                    <Cell value={String(cat.category_name ?? '-')} />
                    <Cell value={displayNumber(cat.pv, 0)} />
                    <Cell value={displayNumber(cat.buy, 0)} />
                    <Cell value={displayMoney(cat.gmv)} />
                    <Cell value={displayPercent(cat.buy_conversion)} />
                    <Cell value={displayMoney(cat.avg_price)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">类目名为合成映射（synthetic_name）；GMV = 购买事件 × 合成价格。</p>
        </section>
      ) : (
        <section>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.channels.map((channel) => {
              const totalGmv = data.channels.reduce((sum, row) => sum + (Number(row.gmv) || 0), 0);
              const gmvShare = totalGmv > 0 ? (Number(channel.gmv) || 0) / totalGmv : 0;
              return (
                <div key={String(channel.channel)} className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{String(channel.channel ?? '-')}</h3>
                    <span className="text-xs text-slate-500">{displayPercent(gmvShare)} GMV 占比</span>
                  </div>
                  <div className="mb-3 h-3 w-full rounded bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-3 rounded bg-blue-600"
                      style={{ width: `${Math.max(1, gmvShare * 100).toFixed(1)}%` }}
                    />
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <dt className="text-slate-500">店铺数</dt>
                    <dd className="text-right">{displayNumber(channel.shop_count, 0)}</dd>
                    <dt className="text-slate-500">商品数</dt>
                    <dd className="text-right">{displayNumber(channel.item_count, 0)}</dd>
                    <dt className="text-slate-500">曝光</dt>
                    <dd className="text-right">{displayNumber(channel.pv, 0)}</dd>
                    <dt className="text-slate-500">购买</dt>
                    <dd className="text-right">{displayNumber(channel.buy, 0)}</dd>
                    <dt className="text-slate-500">GMV</dt>
                    <dd className="text-right">{displayMoney(channel.gmv)}</dd>
                  </dl>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            渠道 = 店铺 tier（standard / premium / flagship）；事件为真实 UserBehavior，GMV 为合成口径。
          </p>
        </section>
      )}
    </main>
  );
}
