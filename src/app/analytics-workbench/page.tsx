import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { RetailPageShell } from '@/components/layout/RetailPageShell';
import { DatasetSelector } from './dataset-selector';

export const metadata: Metadata = {
  title: '经营分析 BI · Shop Gate',
  description: '用户、渠道活动、利润、库存和商品阶段的电商经营分析。',
};

export const dynamic = 'force-dynamic';

const API_BASE_URL = (
  process.env.SHOPGATE_COMMERCE_API_URL ||
  process.env.SHOPGATE_COMMERCE_API_BASE_URL ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '');
const DEFAULT_DATASET_ID = process.env.SHOPGATE_RETAIL_ANALYTICS_DATASET_ID || 'retail-demo-expanded-v1';

type JsonRecord = Record<string, unknown>;
type View = 'overview' | 'customers' | 'retention' | 'channels' | 'profit' | 'inventory' | 'replenishment' | 'lifecycle' | 'elasticity' | 'trend' | 'drilldown';
type Props = {
  searchParams?: Promise<{
    view?: string;
    dataset_id?: string;
    dimension?: string;
    value?: string;
    filter_dimension?: string;
    filter_value?: string;
    page?: string;
    stage?: string;
    segment?: string;
    health?: string;
    priority?: string;
    price_band?: string;
    start?: string;
    end?: string;
  }>;
};

const VIEW_LABELS: Record<Exclude<View, 'drilldown'>, string> = {
  overview: '总览',
  customers: '用户分群',
  retention: '用户留存',
  channels: '渠道活动',
  profit: '毛利分析',
  inventory: '库存健康',
  replenishment: '补货参考',
  lifecycle: '商品阶段',
  elasticity: '价格带',
  trend: '日趋势',
};

const DRILLDOWN_LABELS: Record<string, string> = {
  item_id: '商品',
  user_id: '用户',
  orders: '订单数',
  users: '购买用户数',
  units: '销售件数',
  net_sales: '估算销售额',
  first_order_date: '首次购买',
  last_order_date: '最近购买',
  closing_stock: '结存库存',
  sold_qty: '窗口销量',
  snapshot_date: '库存日期',
  age_band: '年龄段',
  city_tier: '城市层级',
  member_level: '会员等级',
  pv: '页面浏览量（PV）',
  fav: '收藏次数',
  cart: '加购次数',
  buy: '购买次数',
  buy_conversion: '购买转化率',
};

const DIMENSION_LABELS: Record<string, string> = {
  item: '商品',
  user: '用户',
  channel: '渠道',
  campaign: '活动',
  category: '类目',
};

const LIFECYCLE_STAGE_OPTIONS = [
  { value: '', label: '全部商品', description: '查看全部商品，按估算销售额排序。' },
  { value: '未启动', label: '未启动', description: '窗口内还没有购买记录。' },
  { value: '成长期', label: '成长期', description: '最近才开始有购买，或活跃时间还不长。' },
  { value: '稳定期', label: '稳定期', description: '购买活跃已持续至少 14 天。' },
  { value: '衰退风险', label: '衰退风险', description: '距离最近一次购买已超过 14 天。' },
] as const;

const RFM_SEGMENT_OPTIONS = ['流失风险', '高价值', '新近购买', '稳定复购'] as const;
const INVENTORY_HEALTH_OPTIONS = ['库存正常', '库存积压', '缺货风险', '有库存但无销量'] as const;
const REPLENISHMENT_PRIORITY_OPTIONS = ['优先评估补货', '建议评估补货', '暂不建议补货', '无销量先观察'] as const;
const PRICE_BAND_OPTIONS = ['0-50', '50-200', '200-500', '500-1000', '1000+'] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayNumber(value: unknown, digits = 0): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number(value));
}

function displayMoney(value: unknown): string {
  return `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number(value))}`;
}

function displayPercent(value: unknown): string {
  const parsed = number(value);
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Math.abs(parsed) <= 1 ? parsed * 100 : parsed)}%`;
}

function text(value: unknown, fallback = '-'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function addFilterQuery(query: URLSearchParams, dimension?: string, value?: string): void {
  if (dimension && value) {
    query.set('filter_dimension', dimension);
    query.set('filter_value', value);
  }
}

function hrefFor(
  view: Exclude<View, 'drilldown'>,
  datasetId: string,
  dimension?: string,
  value?: string,
): string {
  const query = new URLSearchParams({ view, dataset_id: datasetId });
  addFilterQuery(query, dimension, value);
  return `/analytics-workbench?${query.toString()}`;
}

function lifecycleHref(datasetId: string, page: number, stage = '', dimension?: string, value?: string): string {
  const query = new URLSearchParams({
    view: 'lifecycle',
    dataset_id: datasetId,
    page: String(page),
  });
  if (stage) query.set('stage', stage);
  addFilterQuery(query, dimension, value);
  return `/analytics-workbench?${query.toString()}`;
}

function trendHref(
  datasetId: string,
  dimension?: string,
  value?: string,
  start?: string,
  end?: string,
): string {
  const query = new URLSearchParams({ view: 'trend', dataset_id: datasetId });
  addFilterQuery(query, dimension, value);
  if (start && end) {
    query.set('start', start);
    query.set('end', end);
  }
  return `/analytics-workbench?${query.toString()}`;
}

function inventoryHref(
  datasetId: string,
  page: number,
  dimension?: string,
  value?: string,
  health?: string,
): string {
  const query = new URLSearchParams({
    view: 'inventory',
    dataset_id: datasetId,
    page: String(page),
  });
  addFilterQuery(query, dimension, value);
  if (health) query.set('health', health);
  return `/analytics-workbench?${query.toString()}`;
}

function replenishmentHref(
  datasetId: string,
  page: number,
  dimension?: string,
  value?: string,
  priority?: string,
): string {
  const query = new URLSearchParams({
    view: 'replenishment',
    dataset_id: datasetId,
    page: String(page),
  });
  addFilterQuery(query, dimension, value);
  if (priority) query.set('priority', priority);
  return `/analytics-workbench?${query.toString()}`;
}

function customerHref(datasetId: string, page: number, dimension?: string, value?: string, segment?: string): string {
  const query = new URLSearchParams({
    view: 'customers',
    dataset_id: datasetId,
    page: String(page),
  });
  addFilterQuery(query, dimension, value);
  if (segment) query.set('segment', segment);
  return `/analytics-workbench?${query.toString()}`;
}

function elasticityHref(
  datasetId: string,
  page: number,
  dimension?: string,
  value?: string,
  priceBand?: string,
): string {
  const query = new URLSearchParams({
    view: 'elasticity',
    dataset_id: datasetId,
    page: String(page),
  });
  addFilterQuery(query, dimension, value);
  if (priceBand) query.set('price_band', priceBand);
  return `/analytics-workbench?${query.toString()}`;
}

function drilldownHref(
  datasetId: string,
  dimension: string,
  value: unknown,
  filterDimension?: string,
  filterValue?: string,
): string {
  const query = new URLSearchParams({
    view: 'drilldown',
    dataset_id: datasetId,
    dimension,
    value: String(value),
  });
  addFilterQuery(query, filterDimension, filterValue);
  return `/analytics-workbench?${query.toString()}`;
}

function filteredOverviewHref(datasetId: string, dimension: string, value: unknown): string {
  return hrefFor('overview', datasetId, dimension, String(value));
}

function addScope(
  query: URLSearchParams,
  dimension: string | undefined,
  value: string | undefined,
  supported: string[] = ['item', 'category', 'channel', 'campaign'],
) {
  if (dimension && value && supported.includes(dimension)) {
    query.set('dimension', dimension);
    query.set('value', value);
  }
}

function ScopeNotice({ dimension, value, datasetId }: { dimension: string; value: string; datasetId: string }) {
  const label = DIMENSION_LABELS[dimension] || dimension;
  const itemScope = dimension === 'item' || dimension === 'category';
  return <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs leading-5 text-sky-950">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p><strong>当前筛选：{label} {value}</strong>。总览、趋势、渠道/活动、利润和用户分群已按此范围重新计算。</p>
      <Link href={hrefFor('overview', datasetId)} className="shrink-0 font-semibold text-primary hover:underline">清除筛选</Link>
    </div>
    <p className="mt-1 text-sky-900/80">{itemScope ? '商品或类目筛选还会同步库存健康、商品经营阶段和价格观察；渠道/活动部分只按筛选订单关联的渠道汇总，不提供商品级会话转化率。' : '渠道或活动筛选没有商品级库存、阶段和价格归因，这三部分仍显示整个数据集，避免制造不存在的关联。'}</p>
  </div>;
}

async function fetchAnalytics(path: string): Promise<JsonRecord | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchDatasetContracts(): Promise<JsonRecord[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/commerce/datasets`, { cache: 'no-store' });
    if (!response.ok) return [];
    const parsed: unknown = await response.json();
    return asArray(parsed);
  } catch {
    return [];
  }
}

function SyntheticBadge() {
  return <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">合成演示数据</span>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p><p className="mt-1 text-xs text-muted-foreground">{hint}</p></article>;
}

function DataTable({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm"><table className="min-w-[760px] divide-y divide-border/70">{children}</table></div>;
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm"><div className="mb-4"><h2 className="text-base font-semibold">{title}</h2>{description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}</div>{children}</section>;
}

function Limitations({ payload }: { payload: JsonRecord | null }) {
  const limitations = Array.isArray(payload?.limitations) ? payload.limitations : [];
  return <p className="text-xs leading-5 text-muted-foreground">口径边界：{limitations.map(String).join('；') || '请先读取数据集契约。'}</p>;
}

function trendDateHref(payload: JsonRecord | null, dateValue: string): string | null {
  const contextUrl = typeof payload?.context_url === 'string' ? payload.context_url : '';
  if (!contextUrl) return null;
  const [pathname, queryString = ''] = contextUrl.split('?');
  const query = new URLSearchParams(queryString);
  query.set('view', 'trend');
  query.set('start', dateValue);
  query.set('end', dateValue);
  return `${pathname}?${query.toString()}`;
}

function TrendChart({ payload, title, description }: { payload: JsonRecord | null; title: string; description: string }) {
  const rows = asArray(payload?.rows);
  const maxPv = Math.max(...rows.map((row) => number(row.pv)), 1);
  const maxCart = Math.max(...rows.map((row) => number(row.cart)), 1);
  const maxBuy = Math.max(...rows.map((row) => number(row.buy)), 1);
  const maxOrders = Math.max(...rows.map((row) => number(row.orders)), 1);
  return <Panel title={title} description={description}>
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">当前范围没有可展示的日趋势数据。</p> : <>
      <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-sky-500" />页面浏览量（PV）</span><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-amber-500" />加购行为（Cart）</span><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />购买行为（Buy）</span><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-violet-500" />订单数</span></div>
      <div className="grid gap-2">{rows.map((row) => {
        const dateValue = text(row.stat_date);
        const dateHref = trendDateHref(payload, dateValue);
        const rowContent = <><span className="text-muted-foreground"><span className="font-medium text-primary">{dateValue}</span></span><div className="grid gap-1"><div className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-sky-500" style={{ width: `${Math.max(number(row.pv) > 0 ? 3 : 0, number(row.pv) / maxPv * 100)}%` }} /></div><div className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-amber-500" style={{ width: `${Math.max(number(row.cart) > 0 ? 3 : 0, number(row.cart) / maxCart * 100)}%` }} /></div><div className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(number(row.buy) > 0 ? 3 : 0, number(row.buy) / maxBuy * 100)}%` }} /></div><div className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-violet-500" style={{ width: `${Math.max(number(row.orders) > 0 ? 3 : 0, number(row.orders) / maxOrders * 100)}%` }} /></div></div><span className="flex flex-wrap justify-end gap-x-2 text-right leading-5 text-muted-foreground"><span>PV {displayNumber(row.pv)}</span><span>Cart {displayNumber(row.cart)}</span><span>Buy {displayNumber(row.buy)}</span><span>订单 {displayNumber(row.orders)}</span></span></>;
        return dateHref ? <Link key={String(row.stat_date)} scroll={false} href={dateHref} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-muted/50" aria-label={`查看 ${dateValue} 的页面浏览、加购、购买和订单明细`}>{rowContent}</Link> : <div key={String(row.stat_date)} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 px-2 py-1 text-xs">{rowContent}</div>;
      })}</div>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">每行显示页面浏览、加购、购买和订单数；颜色条按各自指标的最高日归一化，右侧保留真实数量，因此不要用颜色条长度直接比较不同指标。点击整行可查看当天明细。</p>
    </>}
  </Panel>;
}

function TrendScopeSummary({ payload, dimension, value }: { payload: JsonRecord | null; dimension: string; value: string }) {
  const rows = asArray(payload?.rows);
  const totals = rows.reduce<{ pv: number; cart: number; buy: number; orders: number; netSales: number }>((result, row) => ({
    pv: result.pv + number(row.pv),
    cart: result.cart + number(row.cart),
    buy: result.buy + number(row.buy),
    orders: result.orders + number(row.orders),
    netSales: result.netSales + number(row.net_sales),
  }), { pv: 0, cart: 0, buy: 0, orders: 0, netSales: 0 });
  const label = DIMENSION_LABELS[dimension] || dimension;
  const conversion = totals.pv > 0 ? displayPercent(totals.buy / totals.pv) : '暂无行为数据';
  return <Panel title={`当前筛选摘要：${label} ${value}`} description="下面数字只统计当前筛选范围；顶部总览 KPI 仍按整个数据集统计。渠道或活动尚未采集行为归因时，PV 和购买转化率会显示为暂无行为数据。">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Metric label="页面浏览量（PV）" value={totals.pv > 0 ? `${displayNumber(totals.pv)} 次` : '暂无行为数据'} hint="当前筛选范围的页面浏览事件" />
      <Metric label="加购行为（Cart）" value={totals.cart > 0 ? `${displayNumber(totals.cart)} 次` : '暂无行为数据'} hint="当前筛选范围的加购事件" />
      <Metric label="购买次数（Buy）" value={totals.buy > 0 ? `${displayNumber(totals.buy)} 次` : '暂无行为数据'} hint="当前筛选范围的购买事件" />
      <Metric label="订单数" value={`${displayNumber(totals.orders)} 笔`} hint="当前筛选范围的订单记录" />
      <Metric label="购买转化率（PV→Buy）" value={conversion} hint="购买事件 ÷ 页面浏览事件" />
    </div>
    <p className="mt-3 text-xs text-muted-foreground">当前范围订单净额：{displayMoney(totals.netSales)}。金额为演示订单价格口径，仅用于当前数据集分析。</p>
  </Panel>;
}

function ElasticitySummary({ payload, datasetId, filterDimension, filterValue, priceBand }: { payload: JsonRecord | null; datasetId: string; filterDimension?: string; filterValue?: string; priceBand?: string }) {
  const estimated = payload?.status === 'estimated';
  const experimentReady = payload?.experiment_status === 'synthetic_experiment_reference' || payload?.experiment_status === 'experimental_reference';
  const rows = asArray(payload?.item_elasticities);
  const experimentRows = asArray(payload?.experiment_results);
  const total = number(payload?.eligible_item_count);
  const page = Math.max(number(payload?.page) || 1, 1);
  const pageCount = Math.max(number(payload?.page_count), 1);
  return <>
    <div className={`rounded-xl border p-4 text-sm leading-6 ${estimated ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <strong>{estimated ? '已找到可比较的价格观察' : '暂不计算价格弹性'}</strong>
      <p className="mt-1">{text(payload?.explanation)}</p>
      {estimated ? <p className="mt-1">平均价格弹性：<strong>{text(payload?.elasticity_estimate)}</strong>；可比较商品：{displayNumber(payload?.eligible_item_count)} 个。</p> : <p className="mt-1">还需要：{asStringArray(payload?.required_for_estimation).join('、')}。</p>}
    </div>
    {estimated && rows.length > 0 ? <div className="mt-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">商品级价格观察（共 {displayNumber(total)} 个，每页 20 个）</p><span className="text-xs text-muted-foreground">第 {displayNumber(page)} / {displayNumber(pageCount)} 页</span></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">价格观察次数</th><th className="px-3 py-3">最低成交价</th><th className="px-3 py-3">最高成交价</th><th className="px-3 py-3">购买件数</th><th className="px-3 py-3">价格弹性参考</th></tr></thead><tbody className="divide-y divide-border/60">{rows.map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'item', row.item_id, filterDimension, filterValue)}>商品 {text(row.item_id)}</Link></td><td className="px-3 py-3 text-sm">{displayNumber(row.price_points)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.min_price)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.max_price)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.units)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.elasticity)}</td></tr>)}</tbody></DataTable><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><Link scroll={false} href={page > 1 ? elasticityHref(datasetId, page - 1, filterDimension, filterValue, priceBand) : elasticityHref(datasetId, page, filterDimension, filterValue, priceBand)} aria-disabled={page <= 1} className={`rounded-lg border px-3 py-2 text-sm ${page <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><span className="text-xs text-muted-foreground">第 {displayNumber(page)} 页，共 {displayNumber(pageCount)} 页</span><Link scroll={false} href={page < pageCount ? elasticityHref(datasetId, page + 1, filterDimension, filterValue, priceBand) : elasticityHref(datasetId, page, filterDimension, filterValue, priceBand)} aria-disabled={page >= pageCount} className={`rounded-lg border px-3 py-2 text-sm ${page >= pageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div><p className="mt-2 text-xs leading-5 text-muted-foreground">这里反映的是成交价格与购买量的演示关系，不是价格实验结论；调价前仍需结合活动、流量和利润一起判断。</p></div> : null}
    <div className={`mt-5 rounded-xl border p-4 text-sm leading-6 ${experimentReady ? 'border-sky-200 bg-sky-50 text-sky-950' : 'border-slate-200 bg-slate-50 text-slate-800'}`}>
      <strong>{experimentReady ? '价格实验模拟参考' : '当前没有价格实验数据'}</strong>
      <p className="mt-1">{text(payload?.experiment_explanation, '当前数据没有对照组和处理组的曝光、购买记录，不能计算实验组与对照组的差异。')}</p>
      {experimentReady && experimentRows.length > 0 ? <DataTable><thead className="bg-white/70"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">实验</th><th className="px-3 py-3">对照价格</th><th className="px-3 py-3">处理价格</th><th className="px-3 py-3">对照购买率</th><th className="px-3 py-3">处理购买率</th><th className="px-3 py-3">购买率变化</th></tr></thead><tbody className="divide-y divide-border/60">{experimentRows.map((row) => <tr key={String(row.experiment_id)}><td className="px-3 py-3 text-sm">{text(row.experiment_id)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.control_price)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.treatment_price)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.control_conversion_rate)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.treatment_conversion_rate)}</td><td className="px-3 py-3 text-sm font-semibold">{displayPercent(row.absolute_conversion_lift)}</td></tr>)}</tbody></DataTable> : <p className="mt-2 text-xs">需要同时具备对照组、处理组、每组曝光人数、每组购买人数和分组方式，才会展示实验对比。</p>}
      <p className="mt-2 text-xs text-muted-foreground">这部分只展示实验模拟或已登记实验的购买率差异，不等于自动批准调价；合成实验尤其不能替代真实线上实验。</p>
    </div>
  </>;
}

function RetentionSummary({ payload }: { payload: JsonRecord | null }) {
  const summary = asRecord(payload?.summary);
  const cohorts = asArray(payload?.cohorts);
  const maxPeriod = Math.max(number(payload?.max_period), 1);
  const retentionRate = summary?.retention_7d_rate == null
    ? '暂无完整 7 日数据'
    : displayPercent(summary.retention_7d_rate);
  return <>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric label="首购用户数" value={displayNumber(summary?.buyer_count)} hint="窗口内发生过购买的去重用户" />
      <Metric label="首购周数" value={displayNumber(summary?.cohort_count)} hint="按首次购买所在周分组" />
      <Metric label="可计算 7 日留存用户" value={displayNumber(summary?.eligible_7d_users)} hint="首购周距窗口结束至少 7 天" />
      <Metric label="7 日留存率" value={retentionRate} hint="第 2 周仍购买 ÷ 首购周用户" />
    </div>
    {cohorts.length ? <div className="mt-5"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">首购周</th><th className="px-3 py-3">首购用户</th>{Array.from({ length: maxPeriod }, (_, index) => <th key={index} className="px-3 py-3">{index === 0 ? '首周' : `第 ${index + 1} 周`}</th>)}</tr></thead><tbody className="divide-y divide-border/60">{cohorts.map((cohort) => { const periods = asArray(cohort.periods); return <tr key={String(cohort.cohort_week)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm font-semibold">{text(cohort.cohort_week)}</td><td className="px-3 py-3 text-sm">{displayNumber(cohort.cohort_users)}</td>{Array.from({ length: maxPeriod }, (_, index) => { const period = periods.find((row) => number(row.period) === index); return <td key={index} className="px-3 py-3 text-sm">{period ? `${displayPercent(period.rate)}（${displayNumber(period.users)}人）` : '—'}</td>; })}</tr>; })}</tbody></DataTable></div> : <p className="mt-5 text-sm text-muted-foreground">当前数据集没有可用于留存分析的购买记录。</p>}
    <p className="mt-4 text-xs leading-5 text-muted-foreground">留存只根据购买事件判断：同一用户后续周再次购买，才算仍在留存。首购周距窗口结束不足 7 天的用户不会被纳入整体 7 日留存率，避免把未观察完整的用户误判为流失。</p>
  </>;
}

function ReplenishmentSummary({
  payload,
  datasetId,
  filterDimension,
  filterValue,
  selectedPriority,
}: {
  payload: JsonRecord | null;
  datasetId: string;
  filterDimension?: string;
  filterValue?: string;
  selectedPriority?: string;
}) {
  const summary = asRecord(payload?.summary);
  const assumptions = asRecord(payload?.assumptions);
  const priorityCounts = asRecord(summary?.priority_counts);
  const items = asArray(payload?.items);
  return <>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {REPLENISHMENT_PRIORITY_OPTIONS.map((priority) => <Link key={priority} scroll={false} href={replenishmentHref(datasetId, 1, filterDimension, filterValue, priority)} className={`rounded-2xl border p-4 shadow-sm ${selectedPriority === priority ? 'border-primary bg-primary/10' : 'border-border/70 bg-card/85 hover:border-primary/50'}`}><p className="text-xs font-medium text-muted-foreground">{priority}</p><p className="mt-2 text-2xl font-semibold tracking-tight">{displayNumber(priorityCounts?.[priority])}</p><p className="mt-1 text-xs text-muted-foreground">点击查看对应商品</p></Link>)}
    </div>
    <div className="mt-3 grid grid-cols-2 gap-3">
      <Metric label="参考补货商品数" value={displayNumber(summary?.reference_replenishment_item_count)} hint="按当前假设算出正的参考补货量" />
      <Metric label="参考补货件数" value={displayNumber(summary?.total_reference_replenishment_units)} hint="仅用于估算，不是采购数量" />
    </div>
    <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="font-semibold">这是一份补货参考，不是立即补货指令</p>
      <p className="mt-1 text-xs leading-5">当前假设：供货周期 {displayNumber(assumptions?.lead_time_days)} 天，目标覆盖 {displayNumber(assumptions?.target_days)} 天，共观察 {displayNumber(assumptions?.coverage_days)} 天。参考补货量 = 日均销量 ×（供货周期 + 目标覆盖天数）- 可用库存，最低按 0 计算；还要结合真实采购周期、在途库存和供应商约束确认。</p>
    </div>
    {items.length ? <div className="mt-5"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">判断</th><th className="px-3 py-3">可用库存</th><th className="px-3 py-3">可售天数</th><th className="px-3 py-3">目标周期需求</th><th className="px-3 py-3">参考补货量</th><th className="px-3 py-3">判断说明</th></tr></thead><tbody className="divide-y divide-border/60">{items.map((item) => <tr key={String(item.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(text(payload?.dataset_id), 'item', item.item_id, filterDimension, filterValue)}>商品 {text(item.item_id)}</Link></td><td className="px-3 py-3 text-sm font-semibold">{text(item.replenishment_priority)}</td><td className="px-3 py-3 text-sm">{displayNumber(item.available_stock)}</td><td className="px-3 py-3 text-sm">{displayNumber(item.available_days_cover, 1)} 天</td><td className="px-3 py-3 text-sm">{displayNumber(item.forecast_units_for_target, 1)}</td><td className="px-3 py-3 text-sm font-semibold">{displayNumber(item.reference_replenishment_units)}</td><td className="px-3 py-3 text-xs leading-5 text-muted-foreground">{text(item.reason)}</td></tr>)}</tbody></DataTable></div> : <p className="mt-5 text-sm text-muted-foreground">当前数据集没有可展示的补货参考。</p>}
  </>;
}

export default async function AnalyticsWorkbenchPage({ searchParams }: Props) {
  const params = await searchParams;
  const datasetContracts = await fetchDatasetContracts();
  const requestedDatasetId = params?.dataset_id || DEFAULT_DATASET_ID;
  const requestedContract = datasetContracts.find((contract) => text(contract.dataset_id) === requestedDatasetId);
  if (datasetContracts.length && !requestedContract) {
    const canonicalQuery = new URLSearchParams({
      view: params?.view || 'overview',
      dataset_id: text(datasetContracts[0].dataset_id),
    });
    for (const key of ['dimension', 'value', 'filter_dimension', 'filter_value', 'page', 'stage', 'segment', 'health', 'priority', 'price_band', 'start', 'end'] as const) {
      if (params?.[key]) canonicalQuery.set(key, params[key]);
    }
    redirect(`/analytics-workbench?${canonicalQuery.toString()}`);
  }
  const datasetId = requestedDatasetId;
  const view: View = params?.view === 'drilldown'
    ? 'drilldown'
    : Object.keys(VIEW_LABELS).includes(params?.view || '')
      ? params?.view as Exclude<View, 'drilldown'>
      : 'overview';
  const requestedLifecyclePage = Number.parseInt(params?.page || '1', 10);
  const safePage = Number.isFinite(requestedLifecyclePage) && requestedLifecyclePage > 0 ? requestedLifecyclePage : 1;
  const lifecyclePage = view === 'lifecycle' ? safePage : 1;
  const requestedInventoryPage = Number.parseInt(params?.page || '1', 10);
  const inventoryPage = view === 'inventory' ? (Number.isFinite(requestedInventoryPage) && requestedInventoryPage > 0 ? requestedInventoryPage : 1) : 1;
  const replenishmentPage = view === 'replenishment' ? (Number.isFinite(requestedInventoryPage) && requestedInventoryPage > 0 ? requestedInventoryPage : 1) : 1;
  const customerPage = view === 'customers' ? safePage : 1;
  const elasticityPage = view === 'elasticity' ? safePage : 1;
  const requestedLifecycleStage = params?.stage || '';
  const lifecycleStage = LIFECYCLE_STAGE_OPTIONS.some((option) => option.value === requestedLifecycleStage)
    ? requestedLifecycleStage
    : '';
  const requestedCustomerSegment = params?.segment?.trim() || '';
  const customerSegment = RFM_SEGMENT_OPTIONS.includes(requestedCustomerSegment as (typeof RFM_SEGMENT_OPTIONS)[number])
    ? requestedCustomerSegment
    : '';
  const requestedInventoryHealth = params?.health?.trim() || '';
  const inventoryHealth = INVENTORY_HEALTH_OPTIONS.includes(requestedInventoryHealth as (typeof INVENTORY_HEALTH_OPTIONS)[number])
    ? requestedInventoryHealth
    : '';
  const requestedReplenishmentPriority = params?.priority?.trim() || '';
  const replenishmentPriority = REPLENISHMENT_PRIORITY_OPTIONS.includes(requestedReplenishmentPriority as (typeof REPLENISHMENT_PRIORITY_OPTIONS)[number])
    ? requestedReplenishmentPriority
    : '';
  const requestedPriceBand = params?.price_band?.trim() || '';
  const priceBand = PRICE_BAND_OPTIONS.includes(requestedPriceBand as (typeof PRICE_BAND_OPTIONS)[number])
    ? requestedPriceBand
    : '';
  const trendStart = params?.start?.trim() || undefined;
  const trendEnd = params?.end?.trim() || undefined;
  const lifecycleQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(lifecyclePage),
  });
  if (lifecycleStage) lifecycleQuery.set('stage', lifecycleStage);
  const inventoryQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(inventoryPage),
  });
  if (inventoryHealth) inventoryQuery.set('health', inventoryHealth);
  const replenishmentQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(replenishmentPage),
  });
  if (replenishmentPriority) replenishmentQuery.set('priority', replenishmentPriority);
  const customerQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(customerPage),
  });
  if (customerSegment) customerQuery.set('segment', customerSegment);
  const elasticityQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(elasticityPage),
  });
  if (priceBand) elasticityQuery.set('price_band', priceBand);
  const scopeDimension = params?.filter_dimension && ['item', 'category', 'channel', 'campaign'].includes(params.filter_dimension)
    ? params.filter_dimension
    : undefined;
  const scopeValue = scopeDimension && params?.filter_value?.trim() ? params.filter_value : undefined;
  const itemScopeDimension = scopeDimension === 'item' || scopeDimension === 'category' ? scopeDimension : undefined;
  const scopeQuery = new URLSearchParams({ dataset_id: datasetId });
  addScope(scopeQuery, scopeDimension, scopeValue);
  addScope(customerQuery, scopeDimension, scopeValue);
  addScope(inventoryQuery, scopeDimension, scopeValue, ['item', 'category']);
  addScope(replenishmentQuery, scopeDimension, scopeValue, ['item', 'category']);
  addScope(lifecycleQuery, scopeDimension, scopeValue, ['item', 'category']);
  addScope(elasticityQuery, scopeDimension, scopeValue, ['item', 'category']);
  const trendQuery = new URLSearchParams({ dataset_id: datasetId });
  const trendDimension = params?.view === 'drilldown' || params?.view === 'trend'
    ? params?.dimension || scopeDimension
    : scopeDimension;
  const trendValue = params?.view === 'drilldown' || params?.view === 'trend'
    ? params?.value || scopeValue
    : scopeValue;
  if (trendDimension && trendValue) {
    trendQuery.set('dimension', trendDimension);
    trendQuery.set('value', trendValue);
    if (params?.view === 'drilldown' || params?.view === 'trend') {
      addScope(trendQuery, itemScopeDimension, scopeValue, ['item', 'category']);
    }
  }
  if (view === 'trend' && trendStart && trendEnd) {
    trendQuery.set('start', trendStart);
    trendQuery.set('end', trendEnd);
  }
  const [overview, rfm, retention, channels, profit, inventory, replenishment, lifecycle, elasticity] = await Promise.all([
    fetchAnalytics(`/api/v1/commerce/analytics/overview?${scopeQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/rfm?${customerQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/retention?${scopeQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/channel-campaign?${scopeQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/profit?${scopeQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/inventory?${inventoryQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/replenishment?${replenishmentQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/lifecycle?${lifecycleQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/price-elasticity?${elasticityQuery.toString()}`),
  ]);
  const trend = await fetchAnalytics(`/api/v1/commerce/analytics/trend?${trendQuery.toString()}`);
  const contract = asRecord(overview?.contract);
  const metrics = asRecord(overview?.metrics);
  const quality = asRecord(overview?.quality);
  const retentionSummary = asRecord(retention?.summary);
  const replenishmentSummary = asRecord(replenishment?.summary);
  const replenishmentPriorityCounts = asRecord(replenishmentSummary?.priority_counts);
  const contractWindow = `${text(contract?.window_start)} ~ ${text(contract?.window_end)}`;
  const tabs = (Object.entries(VIEW_LABELS) as Array<[Exclude<View, 'drilldown'>, string]>).map(([key, label]) => ({
    href: key === 'customers'
      ? customerHref(datasetId, 1, scopeDimension, scopeValue, customerSegment)
      : key === 'inventory'
        ? inventoryHref(datasetId, 1, itemScopeDimension, scopeValue, inventoryHealth)
        : key === 'replenishment'
          ? replenishmentHref(datasetId, 1, itemScopeDimension, scopeValue, replenishmentPriority)
      : key === 'elasticity'
          ? elasticityHref(datasetId, 1, itemScopeDimension, scopeValue, priceBand)
        : key === 'lifecycle'
          ? lifecycleHref(datasetId, 1, lifecycleStage, itemScopeDimension, scopeValue)
        : key === 'trend'
          ? trendHref(datasetId, scopeDimension, scopeValue, trendStart, trendEnd)
        : hrefFor(key, datasetId, scopeDimension, scopeValue),
    label,
    active: view === key,
  }));

  let drilldown: JsonRecord | null = null;
  if (params?.view === 'drilldown' && params.dimension && params.value) {
    const drilldownQuery = new URLSearchParams({
      dataset_id: datasetId,
      dimension: params.dimension,
      value: params.value,
    });
    addScope(drilldownQuery, itemScopeDimension, scopeValue, ['item', 'category']);
    drilldown = await fetchAnalytics(`/api/v1/commerce/analytics/drilldown?${drilldownQuery.toString()}`);
  }
  const lifecycleTotal = number(lifecycle?.filtered_item_count);
  const lifecyclePageCount = Math.max(number(lifecycle?.page_count), 1);
  const lifecycleCurrentPage = Math.max(number(lifecycle?.page) || 1, 1);
  const inventoryTotal = number(inventoryHealth ? inventory?.filtered_item_count : inventory?.item_count);
  const inventoryPageCount = Math.max(number(inventory?.page_count), 1);
  const inventoryCurrentPage = Math.max(number(inventory?.page) || 1, 1);
  const replenishmentTotal = number(replenishmentPriority
    ? asRecord(replenishment?.summary)?.filtered_item_count
    : asRecord(replenishment?.summary)?.item_count);
  const replenishmentPageCount = Math.max(number(replenishment?.page_count), 1);
  const replenishmentCurrentPage = Math.max(number(replenishment?.page) || 1, 1);
  const customerTotal = number(customerSegment ? (rfm?.filtered_customer_count ?? rfm?.customer_count) : rfm?.customer_count);
  const customerPageCount = Math.max(number(rfm?.page_count), 1);
  const customerCurrentPage = Math.max(number(rfm?.page) || 1, 1);
  const drilldownTargetDimension = text(drilldown?.context && asRecord(drilldown.context)?.dimension, params?.dimension || '');
  const drilldownTargetValue = text(drilldown?.context && asRecord(drilldown.context)?.value, params?.value || '');
  const drilldownParentLabel = itemScopeDimension && scopeValue
    ? `${DIMENSION_LABELS[itemScopeDimension] || itemScopeDimension} ${scopeValue}`
    : null;
  const drilldownBackHref = drilldownParentLabel
    ? hrefFor('overview', datasetId, itemScopeDimension, scopeValue)
    : params?.dimension && params?.value
      ? filteredOverviewHref(datasetId, params.dimension, params.value)
      : hrefFor('overview', datasetId);
  const trendBackHref = params?.dimension && params?.value
    ? drilldownHref(datasetId, params.dimension, params.value, itemScopeDimension, scopeValue)
    : hrefFor('overview', datasetId, scopeDimension, scopeValue);

  return (
    <RetailPageShell
      title="经营分析 BI"
      subtitle={`数据集 ${datasetId} · 窗口 ${contractWindow}`}
      badge={<SyntheticBadge />}
      tabs={tabs}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/75 p-4 shadow-sm">
        <div><p className="text-sm font-semibold">从总览到商品明细</p><p className="mt-1 text-xs text-muted-foreground">先看经营结果，再按用户、渠道、利润、库存和商品阶段查看原因。</p></div>
        <div className="flex flex-wrap gap-2 text-xs"><Link href="/commerce-platform" className="rounded-lg bg-muted px-3 py-2 hover:text-foreground">商品运营</Link><Link href="/operations-briefing" className="rounded-lg bg-muted px-3 py-2 hover:text-foreground">经营情报</Link><span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">质量：{text(quality?.severity, '未扫描')}</span></div>
      </div>

      <DatasetSelector
        contracts={datasetContracts}
        selectedDatasetId={datasetId}
        view={params?.view === 'drilldown' ? 'drilldown' : view}
        dimension={params?.dimension}
        value={params?.value}
        filterDimension={scopeDimension}
        filterValue={scopeValue}
        apiBaseUrl={API_BASE_URL}
      />

      {scopeDimension && scopeValue && view !== 'overview' && view !== 'drilldown' ? <div className="mb-5"><ScopeNotice dimension={scopeDimension} value={scopeValue} datasetId={datasetId} /></div> : null}

      {!overview ? <Panel title="暂时无法读取经营分析数据"><p className="text-sm text-destructive">commerce-data 未返回扩展数据集，请确认服务已启动且 dataset_id 有效。</p></Panel> : null}

      {view === 'trend' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
            <div><h2 className="font-semibold">日趋势明细</h2><p className="mt-1 text-xs leading-5 text-sky-900/80">当前只查看 {trendStart || text(contract?.window_start)} 至 {trendEnd || text(contract?.window_end)}；页面浏览量、购买行为和订单数均按这个日期范围重新统计。</p></div>
            <Link href={trendBackHref} className="shrink-0 font-semibold text-primary hover:underline">返回上一级</Link>
          </div>
          {trendDimension && trendValue ? <TrendScopeSummary payload={trend} dimension={trendDimension} value={trendValue} /> : null}
          <TrendChart payload={trend} title={trendDimension && trendValue ? `筛选范围趋势：${DIMENSION_LABELS[trendDimension] || trendDimension} ${trendValue}` : '全店日趋势'} description="点击总览或明细趋势中的日期，可进入当天的趋势明细；右侧数字是真实数量。" />
          <Limitations payload={trend} />
        </div>
      ) : null}

      {view === 'overview' ? (
        <div className="space-y-5">
          {scopeDimension && scopeValue ? <ScopeNotice dimension={scopeDimension} value={scopeValue} datasetId={datasetId} /> : null}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Metric label="订单数" value={displayNumber(metrics?.orders)} hint="扩展数据集订单记录" /><Metric label="有订单用户" value={displayNumber(metrics?.buyers)} hint="去重用户数" /><Metric label="销售件数" value={displayNumber(metrics?.units)} hint="订单商品数量" /><Metric label="估算销售额" value={displayMoney(metrics?.net_sales)} hint="演示数据的订单价格合计" /><Metric label="估算毛利" value={displayMoney(asRecord(profit?.total)?.gross_profit)} hint="估算销售额减演示成本" /></div>
          {trendDimension && trendValue ? <TrendScopeSummary payload={trend} dimension={trendDimension} value={trendValue} /> : null}
          <TrendChart payload={trend} title={trendDimension && trendValue ? `筛选范围趋势：${DIMENSION_LABELS[trendDimension] || trendDimension} ${trendValue}` : '全店日趋势'} description={trendDimension && trendValue ? '当前图表已跟随筛选条件刷新；右侧数字是真实数量，颜色只用于看变化方向。' : '按天查看页面浏览、购买行为和订单变化，先看整体走势，再进入渠道、类目或商品明细。'} />
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="用户分群" description="用最近购买、购买次数和订单净金额帮助定位用户经营重点。"><div className="grid grid-cols-2 gap-3">{Object.entries(asRecord(rfm?.segment_counts) ?? {}).map(([label, value]) => <Link key={label} href={customerHref(datasetId, 1, scopeDimension, scopeValue, label)} className="rounded-xl border border-border/60 bg-muted/30 p-3 hover:border-primary/40"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{displayNumber(value)}</p><p className="mt-1 text-[11px] text-muted-foreground">查看用户明细 →</p></Link>)}</div></Panel>
            <Panel title="库存健康" description="可售天数只用于识别库存结构，不直接等于补货指令。点击判断标签，可查看对应商品明细。"><div className="grid grid-cols-2 gap-3">{INVENTORY_HEALTH_OPTIONS.map((label) => <Link key={label} href={inventoryHref(datasetId, 1, itemScopeDimension, scopeValue, label)} className="rounded-xl border border-border/60 bg-muted/30 p-3 hover:border-primary/40"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{displayNumber(asRecord(inventory?.risk_counts)?.[label])}</p><p className="mt-1 text-[11px] text-muted-foreground">查看对应商品 →</p></Link>)}</div></Panel>
          </div>
          <Panel title={scopeDimension === 'item' || scopeDimension === 'category' ? '筛选范围的渠道销售' : '渠道与活动贡献'} description={scopeDimension === 'item' || scopeDimension === 'category' ? '这里只按当前商品或类目关联的订单汇总渠道销售；数据没有商品级渠道曝光映射，因此不显示会话转化率。' : '这里是合成会话归因，不代表广告平台真实归因。点击渠道名称可查看该渠道的商品和购买表现。'}><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">活动</th><th className="px-3 py-3">会话</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">{scopeDimension === 'item' || scopeDimension === 'category' ? '统计说明' : '订单转化率'}</th><th className="px-3 py-3">净销售额</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(channels?.metrics).slice(0, 6).map((row, index) => <tr key={`${String(row.channel_id)}-${index}`} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'channel', row.channel_id, itemScopeDimension, scopeValue)}>{text(row.channel_name)}</Link></td><td className="px-3 py-3 text-sm">{row.campaign_id !== undefined ? <Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'campaign', row.campaign_id, itemScopeDimension, scopeValue)}>{text(row.campaign_name)}</Link> : text(row.campaign_name)}</td><td className="px-3 py-3 text-sm">{scopeDimension === 'item' || scopeDimension === 'category' ? '不提供' : displayNumber(row.sessions)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{scopeDimension === 'item' || scopeDimension === 'category' ? '按订单关联渠道统计' : displayPercent(row.order_conversion)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td></tr>)}</tbody></DataTable><div className="mt-3 text-right"><Link className="text-sm font-semibold text-primary hover:underline" href={hrefFor('channels', datasetId, scopeDimension, scopeValue)}>查看全部渠道和活动 →</Link></div></Panel>
          <div className="grid gap-5 lg:grid-cols-2"><Panel title="商品阶段" description="根据窗口内购买活跃度推断，不等于真实上架/下架生命周期。"><div className="grid grid-cols-2 gap-2">{Object.entries(asRecord(lifecycle?.stage_counts) ?? {}).map(([label, value]) => <Link key={label} href={lifecycleHref(datasetId, 1, label, itemScopeDimension, scopeValue)} className="flex items-center justify-between rounded-lg bg-muted/35 px-3 py-2 text-sm hover:bg-muted"><span>{label}</span><strong>{displayNumber(value)}</strong></Link>)}</div></Panel><Panel title="价格与成交关系" description="只有同一商品出现多个成交价格时，才提供价格弹性参考。"><Link href={hrefFor('elasticity', datasetId, scopeDimension === 'item' || scopeDimension === 'category' ? scopeDimension : undefined, scopeValue)} className="block rounded-xl border border-border/60 bg-muted/20 p-4 text-sm hover:border-primary/50"><span>{elasticity?.status === 'estimated' ? `平均价格弹性 ${text(elasticity?.elasticity_estimate)}` : '当前数据还不能估算价格弹性'}</span><span className="mt-2 block text-xs font-semibold">查看价格带与商品观察 →</span></Link></Panel></div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="用户留存" description="按首次购买所在周观察后续是否再次购买；这不是登录留存，也不把浏览当成留存。"><Link href={hrefFor('retention', datasetId, scopeDimension, scopeValue)} className="block rounded-xl border border-border/60 bg-muted/20 p-4 hover:border-primary/50"><div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">首购用户</p><p className="mt-1 text-xl font-semibold">{displayNumber(retentionSummary?.buyer_count)}</p></div><div><p className="text-xs text-muted-foreground">首购周数</p><p className="mt-1 text-xl font-semibold">{displayNumber(retentionSummary?.cohort_count)}</p></div><div><p className="text-xs text-muted-foreground">7 日留存率</p><p className="mt-1 text-xl font-semibold">{retentionSummary?.retention_7d_rate == null ? '暂无' : displayPercent(retentionSummary.retention_7d_rate)}</p></div></div><span className="mt-3 block text-xs font-semibold text-primary">查看完整留存分析 →</span></Link></Panel>
            <Panel title="补货参考" description="按库存和日均销量列出需要优先核实的商品；参考结果不等于立即补货指令。"><Link href={replenishmentHref(datasetId, 1, itemScopeDimension, scopeValue)} className="block rounded-xl border border-border/60 bg-muted/20 p-4 hover:border-primary/50"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{REPLENISHMENT_PRIORITY_OPTIONS.map((priority) => <div key={priority}><p className="text-xs text-muted-foreground">{priority}</p><p className="mt-1 text-xl font-semibold">{displayNumber(replenishmentPriorityCounts?.[priority])}</p></div>)}</div><span className="mt-3 block text-xs font-semibold text-primary">查看完整补货参考 →</span></Link></Panel>
          </div>
          <Limitations payload={overview} />
        </div>
      ) : null}

      {view === 'customers' ? <Panel title="用户分群（RFM）" description="这里展示数据集中的全部有订单用户，每页 20 个；页面用“最近购买、购买次数、订单金额”解释用户分群。"><div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm"><span>{customerSegment ? `当前分群：${customerSegment}；` : ''}当前显示第 {displayNumber(customerCurrentPage)} 页，共 {displayNumber(customerPageCount)} 页；{customerSegment ? `当前分群用户 ${displayNumber(customerTotal)} 个` : `全部用户 ${displayNumber(customerTotal)} 个`}</span><span className="text-xs text-muted-foreground">按订单净金额从高到低排列，每页 20 个</span></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">用户</th><th className="px-3 py-3">分群</th><th className="px-3 py-3">最近购买距今天数</th><th className="px-3 py-3">订单数</th><th className="px-3 py-3">订单净金额</th><th className="px-3 py-3">用户属性</th><th className="px-3 py-3">查看明细</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(rfm?.customers).map((row) => <tr key={String(row.user_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">用户 {text(row.user_id)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.segment)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.recency_days)} 天</td><td className="px-3 py-3 text-sm">{displayNumber(row.frequency)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.monetary)}</td><td className="px-3 py-3 text-sm text-muted-foreground">{text(row.age_band)} · {text(row.city_tier)} · {text(row.member_level)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'user', row.user_id, itemScopeDimension, scopeValue)}>查看用户明细</Link></td></tr>)}</tbody></DataTable><div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Link scroll={false} href={customerCurrentPage > 1 ? customerHref(datasetId, customerCurrentPage - 1, scopeDimension, scopeValue, customerSegment) : customerHref(datasetId, customerCurrentPage, scopeDimension, scopeValue, customerSegment)} aria-disabled={customerCurrentPage <= 1} className={`rounded-lg border px-3 py-2 text-sm ${customerCurrentPage <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><div className="text-xs text-muted-foreground">第 {displayNumber(customerCurrentPage)} 页，共 {displayNumber(customerPageCount)} 页</div><Link scroll={false} href={customerCurrentPage < customerPageCount ? customerHref(datasetId, customerCurrentPage + 1, scopeDimension, scopeValue, customerSegment) : customerHref(datasetId, customerCurrentPage, scopeDimension, scopeValue, customerSegment)} aria-disabled={customerCurrentPage >= customerPageCount} className={`rounded-lg border px-3 py-2 text-sm ${customerCurrentPage >= customerPageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div><div className="mt-4"><Limitations payload={rfm} /></div></Panel> : null}

      {view === 'retention' ? <Panel title="用户留存分析" description="按用户第一次购买所在周分组，观察之后各周是否再次购买；这不是登录留存，也不把页面浏览当成留存。"><RetentionSummary payload={retention} /><div className="mt-4"><Limitations payload={retention} /></div></Panel> : null}

      {view === 'channels' ? <Panel title={scopeDimension === 'item' || scopeDimension === 'category' ? '筛选范围的渠道销售' : '渠道与活动归因'} description={scopeDimension === 'item' || scopeDimension === 'category' ? '这里只按当前商品或类目关联的订单汇总渠道销售；数据没有商品级渠道曝光映射，因此不显示会话转化率。' : '订单转化率 = 订单数 ÷ 会话数；这是演示会话归因，不是平台广告归因。'}><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">活动</th><th className="px-3 py-3">渠道类型</th><th className="px-3 py-3">会话</th><th className="px-3 py-3">独立用户</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">{scopeDimension === 'item' || scopeDimension === 'category' ? '统计说明' : '订单转化率'}</th><th className="px-3 py-3">净销售额</th><th className="px-3 py-3">查看明细</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(channels?.metrics).map((row, index) => <tr key={`${String(row.channel_id)}-${String(row.campaign_id)}-${index}`} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">{text(row.channel_name)}</td><td className="px-3 py-3 text-sm">{row.campaign_id !== undefined ? <Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'campaign', row.campaign_id, itemScopeDimension, scopeValue)}>{text(row.campaign_name)}</Link> : text(row.campaign_name)}</td><td className="px-3 py-3 text-sm text-muted-foreground">{text(row.channel_type)}</td><td className="px-3 py-3 text-sm">{scopeDimension === 'item' || scopeDimension === 'category' ? '不提供' : displayNumber(row.sessions)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.users)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{scopeDimension === 'item' || scopeDimension === 'category' ? '按订单关联渠道统计' : displayPercent(row.order_conversion)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'channel', row.channel_id, itemScopeDimension, scopeValue)}>查看渠道明细</Link></td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={channels} /></div></Panel> : null}

      {view === 'profit' ? <Panel title="毛利分析" description="毛利 = 销售额 - 成本；这里是演示数据估算，不是财务结算报表。"><div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5"><Metric label="销售额" value={displayMoney(asRecord(profit?.total)?.gross_sales)} hint="订单价格合计" /><Metric label="退款" value={displayMoney(asRecord(profit?.total)?.refunds)} hint="演示退款金额" /><Metric label="成本" value={displayMoney(asRecord(profit?.total)?.cost)} hint="演示商品成本" /><Metric label="毛利" value={displayMoney(asRecord(profit?.total)?.gross_profit)} hint="销售额减退款和成本" /><Metric label="毛利率" value={displayPercent(asRecord(profit?.total)?.gross_margin)} hint="毛利 ÷ 销售额" /></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">销售额</th><th className="px-3 py-3">退款</th><th className="px-3 py-3">成本</th><th className="px-3 py-3">毛利</th><th className="px-3 py-3">毛利率</th><th className="px-3 py-3">查看明细</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(profit?.by_channel).map((row) => <tr key={String(row.channel_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'channel', row.channel_id, itemScopeDimension, scopeValue)}>{text(row.channel_name)}</Link></td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.gross_sales)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.refunds)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.cost)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.gross_profit)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.gross_margin)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'channel', row.channel_id, itemScopeDimension, scopeValue)}>查看渠道明细</Link></td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={profit} /></div></Panel> : null}

      {view === 'inventory' ? <Panel title="库存健康" description="这里展示全部商品，每页 20 个。可售天数 = 结存库存 ÷ 平均日销量；没有销量的商品会单独标记。点击下面的判断标签可以筛选对应商品。"><div className="mb-5 rounded-xl border border-border/60 bg-muted/20 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">按库存判断查看</p><span className="text-xs text-muted-foreground">数量是当前范围内的商品数</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Link scroll={false} href={inventoryHref(datasetId, 1, itemScopeDimension, scopeValue)} className={`rounded-xl border p-3 ${!inventoryHealth ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}><p className="text-sm font-semibold">全部商品</p><p className="mt-1 text-lg font-semibold">{displayNumber(inventory?.item_count)}</p><p className="mt-1 text-[11px] text-muted-foreground">查看完整库存列表</p></Link>{INVENTORY_HEALTH_OPTIONS.map((label) => <Link key={label} scroll={false} href={inventoryHref(datasetId, 1, itemScopeDimension, scopeValue, label)} className={`rounded-xl border p-3 ${inventoryHealth === label ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}><p className="text-sm font-semibold">{label}</p><p className="mt-1 text-lg font-semibold">{displayNumber(asRecord(inventory?.risk_counts)?.[label])}</p><p className="mt-1 text-[11px] text-muted-foreground">查看对应商品明细</p></Link>)}</div></div><div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm"><span>当前查看：{inventoryHealth || '全部商品'}；第 {displayNumber(inventoryCurrentPage)} / {displayNumber(inventoryPageCount)} 页，共 {displayNumber(inventoryTotal)} 个商品</span><span className="text-xs text-muted-foreground">按结存库存从高到低排列，每页 20 个</span></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">库存判断</th><th className="px-3 py-3">结存库存</th><th className="px-3 py-3">平均日销量</th><th className="px-3 py-3">可售天数</th><th className="px-3 py-3">窗口销量</th><th className="px-3 py-3">查看明细</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(inventory?.items).map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">商品 {text(row.item_id)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.health_label)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.closing_stock)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.average_daily_sold, 2)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.days_cover, 1)} 天</td><td className="px-3 py-3 text-sm">{displayNumber(row.sold_units)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'item', row.item_id, itemScopeDimension, scopeValue)}>查看商品明细</Link></td></tr>)}</tbody></DataTable><div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Link scroll={false} href={inventoryCurrentPage > 1 ? inventoryHref(datasetId, inventoryCurrentPage - 1, itemScopeDimension, scopeValue, inventoryHealth) : inventoryHref(datasetId, inventoryCurrentPage, itemScopeDimension, scopeValue, inventoryHealth)} aria-disabled={inventoryCurrentPage <= 1} className={`rounded-lg border px-3 py-2 text-sm ${inventoryCurrentPage <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><div className="text-xs text-muted-foreground">第 {displayNumber(inventoryCurrentPage)} 页，共 {displayNumber(inventoryPageCount)} 页</div><Link scroll={false} href={inventoryCurrentPage < inventoryPageCount ? inventoryHref(datasetId, inventoryCurrentPage + 1, itemScopeDimension, scopeValue, inventoryHealth) : inventoryHref(datasetId, inventoryCurrentPage, itemScopeDimension, scopeValue, inventoryHealth)} aria-disabled={inventoryCurrentPage >= inventoryPageCount} className={`rounded-lg border px-3 py-2 text-sm ${inventoryCurrentPage >= inventoryPageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div><div className="mt-4"><Limitations payload={inventory} /></div></Panel> : null}

      {view === 'replenishment' ? <Panel title="补货参考" description="按库存、日均销量和可解释的供货假设排序，帮助你先找出需要进一步核实的商品。点击上方判断可筛选对应商品。">
        <ReplenishmentSummary payload={replenishment} datasetId={datasetId} filterDimension={itemScopeDimension} filterValue={scopeValue} selectedPriority={replenishmentPriority} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm"><span>当前查看：{replenishmentPriority || '全部商品'}；第 {displayNumber(replenishmentCurrentPage)} / {displayNumber(replenishmentPageCount)} 页，共 {displayNumber(replenishmentTotal)} 个商品</span><span className="text-xs text-muted-foreground">按补货优先级和参考补货量排序，每页 20 个</span></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Link scroll={false} href={replenishmentCurrentPage > 1 ? replenishmentHref(datasetId, replenishmentCurrentPage - 1, itemScopeDimension, scopeValue, replenishmentPriority) : replenishmentHref(datasetId, replenishmentCurrentPage, itemScopeDimension, scopeValue, replenishmentPriority)} aria-disabled={replenishmentCurrentPage <= 1} className={`rounded-lg border px-3 py-2 text-sm ${replenishmentCurrentPage <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><div className="text-xs text-muted-foreground">第 {displayNumber(replenishmentCurrentPage)} 页，共 {displayNumber(replenishmentPageCount)} 页</div><Link scroll={false} href={replenishmentCurrentPage < replenishmentPageCount ? replenishmentHref(datasetId, replenishmentCurrentPage + 1, itemScopeDimension, scopeValue, replenishmentPriority) : replenishmentHref(datasetId, replenishmentCurrentPage, itemScopeDimension, scopeValue, replenishmentPriority)} aria-disabled={replenishmentCurrentPage >= replenishmentPageCount} className={`rounded-lg border px-3 py-2 text-sm ${replenishmentCurrentPage >= replenishmentPageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div>
        <div className="mt-4"><Limitations payload={replenishment} /></div>
      </Panel> : null}

      {view === 'lifecycle' ? <Panel title="商品经营阶段" description="这里展示全部商品，每页 20 个。阶段是根据购买记录推断的经营状态，不等于真实上架或下架生命周期。">
        <div className="mb-5 rounded-xl border border-border/60 bg-muted/20 p-4">
          <p className="text-sm font-semibold">选择要查看的阶段</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">点击下面的阶段即可筛选商品；数量是当前数据集中的全部商品数。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {LIFECYCLE_STAGE_OPTIONS.map((option) => {
              const active = lifecycleStage === option.value;
              const count = option.value ? asRecord(lifecycle?.stage_counts)?.[option.label] : lifecycle?.item_count;
              return <Link key={option.value || 'all'} href={lifecycleHref(datasetId, 1, option.value, itemScopeDimension, scopeValue)} className={`rounded-xl border p-3 transition-colors ${active ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{option.label}</span><strong className="text-lg">{displayNumber(count)}</strong></div><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{option.description}</p></Link>;
            })}
          </div>
        </div>
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><p className="font-semibold">判断规则</p><ul className="mt-2 grid gap-1 text-xs leading-5 sm:grid-cols-2"><li>未启动：窗口内没有购买记录。</li><li>成长期：最近 14 天才开始购买，或活跃时间还不长。</li><li>稳定期：购买活跃持续至少 14 天。</li><li>衰退风险：距离最近一次购买超过 14 天。</li></ul><p className="mt-2 text-xs leading-5 text-sky-900/80">这些规则只根据当前数据窗口内的购买记录判断；如果没有真实上架、下架、补货和停售事件，就不能把它当成商品真实生命周期。</p></div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span>当前查看：{lifecycleStage || '全部商品'}，共 {displayNumber(lifecycleTotal)} 个商品</span><span className="text-xs text-muted-foreground">第 {displayNumber(lifecycleCurrentPage)} / {displayNumber(lifecyclePageCount)} 页，每页 20 个</span></div>
        <DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">类目</th><th className="px-3 py-3">阶段</th><th className="px-3 py-3">首次购买</th><th className="px-3 py-3">最近购买</th><th className="px-3 py-3">活跃天数</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">估算销售额</th><th className="px-3 py-3">查看明细</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(lifecycle?.items).map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">商品 {text(row.item_id)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'category', row.category_id, itemScopeDimension, scopeValue)}>类目 {text(row.category_id)}</Link></td><td className="px-3 py-3 text-sm font-semibold">{text(row.stage)}</td><td className="px-3 py-3 text-sm">{text(row.first_order_date, '暂无购买')}</td><td className="px-3 py-3 text-sm">{text(row.last_order_date, '暂无购买')}</td><td className="px-3 py-3 text-sm">{row.active_days === null ? '-' : displayNumber(row.active_days)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'item', row.item_id, itemScopeDimension, scopeValue)}>查看商品明细</Link></td></tr>)}</tbody></DataTable>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Link scroll={false} href={lifecycleCurrentPage > 1 ? lifecycleHref(datasetId, lifecycleCurrentPage - 1, lifecycleStage, itemScopeDimension, scopeValue) : lifecycleHref(datasetId, lifecycleCurrentPage, lifecycleStage, itemScopeDimension, scopeValue)} aria-disabled={lifecycleCurrentPage <= 1} className={`rounded-lg border px-3 py-2 text-sm ${lifecycleCurrentPage <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><div className="flex items-center gap-1 text-xs text-muted-foreground">第 {displayNumber(lifecycleCurrentPage)} 页，共 {displayNumber(lifecyclePageCount)} 页</div><Link scroll={false} href={lifecycleCurrentPage < lifecyclePageCount ? lifecycleHref(datasetId, lifecycleCurrentPage + 1, lifecycleStage, itemScopeDimension, scopeValue) : lifecycleHref(datasetId, lifecycleCurrentPage, lifecycleStage, itemScopeDimension, scopeValue)} aria-disabled={lifecycleCurrentPage >= lifecyclePageCount} className={`rounded-lg border px-3 py-2 text-sm ${lifecycleCurrentPage >= lifecyclePageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div>
        <div className="mt-4"><Limitations payload={lifecycle} /></div>
      </Panel> : null}

      {view === 'elasticity' ? <Panel title="价格带对比与价格弹性参考" description="价格带用于比较商品价格结构；有多个成交价格观察时，额外展示价格与购买量的关系参考。点击价格带可查看该范围的商品观察。"><div className="mb-5 rounded-xl border border-border/60 bg-muted/20 p-4"><p className="text-sm font-semibold">选择价格带</p><p className="mt-1 text-xs leading-5 text-muted-foreground">价格带按商品标价划分；选择后，下面的商品价格观察和实验参考都会同步更新。</p><div className="mt-3 flex flex-wrap gap-2"><Link scroll={false} href={elasticityHref(datasetId, 1, itemScopeDimension, scopeValue)} className={`rounded-lg border px-3 py-2 text-sm ${!priceBand ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}>全部价格带</Link>{PRICE_BAND_OPTIONS.map((band) => <Link key={band} scroll={false} href={elasticityHref(datasetId, 1, itemScopeDimension, scopeValue, band)} className={`rounded-lg border px-3 py-2 text-sm ${priceBand === band ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}>¥{band}</Link>)}</div><p className="mt-3 text-xs text-muted-foreground">当前查看：{priceBand ? `¥${priceBand}` : '全部价格带'}</p></div><ElasticitySummary payload={elasticity} datasetId={datasetId} filterDimension={itemScopeDimension} filterValue={scopeValue} priceBand={priceBand} /><div className="mt-5"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">价格带</th><th className="px-3 py-3">商品数</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">销售件数</th><th className="px-3 py-3">估算销售额</th><th className="px-3 py-3">平均折扣</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(elasticity?.price_band_comparison).map((row) => <tr key={String(row.price_band)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm font-semibold"><Link scroll={false} className="text-primary hover:underline" href={elasticityHref(datasetId, 1, itemScopeDimension, scopeValue, text(row.price_band))}>¥{text(row.price_band)}</Link></td><td className="px-3 py-3 text-sm">{displayNumber(row.item_count)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.units)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.average_discount_rate)}</td></tr>)}</tbody></DataTable></div><div className="mt-4"><Limitations payload={elasticity} /></div></Panel> : null}

      {params?.view === 'drilldown' ? (
        <div className="space-y-5">
          <TrendChart payload={trend} title="当前查看范围的日趋势" description="点击渠道、类目或商品后，趋势会按当前范围重新计算；渠道或活动没有对应行为记录时，页面浏览量会显示为 0。" />
          <Panel title="查看相关明细" description="下面展示当前筛选范围的结果，并提供回到总览或打开这份明细结果的入口。">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/35 p-4 text-sm">
              <span><span className="text-muted-foreground">当前查看条件：</span>{DIMENSION_LABELS[drilldownTargetDimension] || drilldownTargetDimension} = {drilldownTargetValue}{drilldownParentLabel ? `；父级范围：${drilldownParentLabel}` : ''}</span>
              <div className="flex flex-wrap gap-3">
                {params.dimension && params.value ? <Link href={drilldownBackHref} className="font-semibold text-primary hover:underline">回到总览（保留当前筛选）</Link> : null}
                {typeof drilldown?.context_url === 'string' ? <Link href={drilldown.context_url} className="font-semibold text-primary hover:underline">打开这份明细结果</Link> : null}
              </div>
            </div>
            {drilldown ? <DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground">{Object.keys(asArray(drilldown.results)[0] ?? {}).map((key) => <th key={key} className="px-3 py-3">{DRILLDOWN_LABELS[key] || key}</th>)}</tr></thead><tbody className="divide-y divide-border/60">{asArray(drilldown.results).map((row, index) => <tr key={index}>{Object.entries(row).map(([key, value]) => <td key={key} className="px-3 py-3 text-sm">{typeof value === 'number' && /conversion/i.test(key) ? displayPercent(value) : typeof value === 'number' && /sales|amount|profit|cost/i.test(key) ? displayMoney(value) : text(value)}</td>)}</tr>)}</tbody></DataTable> : <p className="mt-4 text-sm text-destructive">没有找到符合当前条件的结果。</p>}
            <div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">可执行的分析建议</p><div className="grid gap-2 sm:grid-cols-2">{asStringArray(drilldown?.action_suggestions).map((action) => <span key={action} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">{action}</span>)}</div></div>
            <div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">你还可以这样问</p><div className="flex flex-wrap gap-2">{asStringArray(drilldown?.next_questions).map((question) => <span key={question} className="rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary">{question}</span>)}</div></div>
            <div className="mt-4"><Limitations payload={drilldown} /></div>
          </Panel>
        </div>
      ) : null}
    </RetailPageShell>
  );
}
