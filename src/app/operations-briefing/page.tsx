import type { Metadata } from 'next';
import Link from 'next/link';
import { getOperationsBriefingData, type OperationsBriefingView } from '@/lib/commerce/retail-briefing';
import {
  displayNumber,
  displayMoney,
  displayPercent,
} from '@/lib/commerce/commerce-platform';

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

function SyntheticBadge() {
  return (
    <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
      合成口径
    </span>
  );
}

function Cell({ value, className }: { value: string; className?: string }) {
  return <td className={`px-3 py-2 text-sm ${className ?? ''}`}>{value}</td>;
}

export default async function OperationsBriefingPage({ searchParams }: Props) {
  const params = await searchParams;
  const data = await getOperationsBriefingData({ view: params?.view });
  const { view } = data;
  const totals = data.daily?.totals as Record<string, unknown> | undefined;
  const dayOverDay = data.daily?.day_over_day as Record<string, unknown> | undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">经营情报</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          窗口 {data.window.start} ~ {data.window.end}；行为流来源{' '}
          <span className="font-mono">{data.behaviorSource}</span>
          {data.behaviorSource === 'synthetic' ? '（合成演示数据）' : '（真实行为流）'}
        </p>
        <div className="mt-2">{<SyntheticBadge />}</div>
      </header>

      <nav className="mb-6 flex gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
        {(Object.keys(VIEW_LABELS) as OperationsBriefingView[]).map((key) => (
          <Link
            key={key}
            href={`/operations-briefing?view=${key}`}
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
      ) : view === 'daily' ? (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">日期</div>
              <div className="mt-1 text-lg font-semibold">{String(data.daily?.stat_date ?? '-')}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">GMV</div>
              <div className="mt-1 text-lg font-semibold">{displayMoney(totals?.gmv)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">曝光</div>
              <div className="mt-1 text-lg font-semibold">{displayNumber(totals?.pv, 0)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">购买转化</div>
              <div className="mt-1 text-lg font-semibold">{displayPercent(data.daily?.buy_conversion)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">客单价</div>
              <div className="mt-1 text-lg font-semibold">{displayMoney(data.daily?.avg_price)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">购买人数</div>
              <div className="mt-1 text-lg font-semibold">{displayNumber(totals?.buyers, 0)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">购买事件</div>
              <div className="mt-1 text-lg font-semibold">{displayNumber(totals?.buy, 0)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">状态</div>
              <div className="mt-1 text-lg font-semibold">{String(data.daily?.status ?? '-')}</div>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {['指标', '日环比'].map((h) => (
                    <th key={h} className="px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {dayOverDay ? Object.entries(dayOverDay).map(([key, value]) => (
                  <tr key={'dod-' + key} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Cell value={key} />
                    <Cell value={value === null ? '-' : displayPercent(value)} />
                  </tr>
                )) : <tr><Cell value="首日或无前日数据，不计算日环比。" /></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">
            日报只描述窗口末日快照，不推断趋势；GMV/客单价为合成口径。
          </p>
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
          <p className="mt-3 text-xs text-slate-400">类目名为合成映射；GMV = 购买事件 × 合成价格。</p>
        </section>
      ) : (
        <section>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {['商品', '类目', '渠道', '价格', '曝光', '购买', 'GMV', '转化'].map((h) => (
                    <th key={h} className="px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.watch.map((item, index) => (
                  <tr key={String(item.item_id ?? index)} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Cell value={String(item.title ?? '-')} />
                    <Cell value={String(item.category_name ?? '-')} />
                    <Cell value={String(item.shop_tier ?? '-')} />
                    <Cell value={displayMoney(item.price)} />
                    <Cell value={displayNumber(item.pv, 0)} />
                    <Cell value={displayNumber(item.buy, 0)} />
                    <Cell value={displayMoney(item.gmv)} />
                    <Cell value={displayPercent(item.buy_conversion)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            观察池=窗口内 GMV 领先商品（top-20）；价格/渠道/GMV 为合成口径。
          </p>
        </section>
      )}
    </main>
  );
}
