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
  process.env.SHOPGATE_MARKET_API_URL ||
  process.env.SHOPGATE_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '');
const DEFAULT_DATASET_ID = process.env.SHOPGATE_RETAIL_ANALYTICS_DATASET_ID || 'retail-demo-expanded-v1';

type JsonRecord = Record<string, unknown>;
type View = 'overview' | 'customers' | 'channels' | 'profit' | 'inventory' | 'lifecycle' | 'elasticity' | 'drilldown';
type Props = {
  searchParams?: Promise<{
    view?: string;
    dataset_id?: string;
    dimension?: string;
    value?: string;
    page?: string;
    stage?: string;
  }>;
};

const VIEW_LABELS: Record<Exclude<View, 'drilldown'>, string> = {
  overview: '总览',
  customers: '用户分群',
  channels: '渠道活动',
  profit: '毛利分析',
  inventory: '库存健康',
  lifecycle: '商品阶段',
  elasticity: '价格带',
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
};

const DIMENSION_LABELS: Record<string, string> = {
  item: '商品',
  user: '用户',
  channel: '渠道',
  campaign: '活动',
};

const LIFECYCLE_STAGE_OPTIONS = [
  { value: '', label: '全部商品', description: '查看全部商品，按估算销售额排序。' },
  { value: '未启动', label: '未启动', description: '窗口内还没有购买记录。' },
  { value: '成长期', label: '成长期', description: '最近才开始有购买，或活跃时间还不长。' },
  { value: '稳定期', label: '稳定期', description: '购买活跃已持续至少 14 天。' },
  { value: '衰退风险', label: '衰退风险', description: '距离最近一次购买已超过 14 天。' },
] as const;

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

function hrefFor(view: Exclude<View, 'drilldown'>, datasetId: string): string {
  return `/analytics-workbench?view=${view}&dataset_id=${encodeURIComponent(datasetId)}`;
}

function lifecycleHref(datasetId: string, page: number, stage = ''): string {
  const query = new URLSearchParams({
    view: 'lifecycle',
    dataset_id: datasetId,
    page: String(page),
  });
  if (stage) query.set('stage', stage);
  return `/analytics-workbench?${query.toString()}`;
}

function drilldownHref(datasetId: string, dimension: string, value: unknown): string {
  return `/analytics-workbench?view=drilldown&dataset_id=${encodeURIComponent(datasetId)}&dimension=${encodeURIComponent(dimension)}&value=${encodeURIComponent(String(value))}`;
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

function ElasticitySummary({ payload }: { payload: JsonRecord | null }) {
  const estimated = payload?.status === 'estimated';
  const rows = asArray(payload?.item_elasticities);
  return <>
    <div className={`rounded-xl border p-4 text-sm leading-6 ${estimated ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <strong>{estimated ? '已找到可比较的价格观察' : '暂不计算价格弹性'}</strong>
      <p className="mt-1">{text(payload?.explanation)}</p>
      {estimated ? <p className="mt-1">平均价格弹性：<strong>{text(payload?.elasticity_estimate)}</strong>；可比较商品：{displayNumber(payload?.eligible_item_count)} 个。</p> : <p className="mt-1">还需要：{asStringArray(payload?.required_for_estimation).join('、')}。</p>}
    </div>
    {estimated && rows.length > 0 ? <div className="mt-4"><p className="mb-2 text-sm font-semibold">商品级价格观察（最多展示 20 个）</p><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">价格观察次数</th><th className="px-3 py-3">最低成交价</th><th className="px-3 py-3">最高成交价</th><th className="px-3 py-3">购买件数</th><th className="px-3 py-3">价格弹性参考</th></tr></thead><tbody className="divide-y divide-border/60">{rows.slice(0, 20).map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">商品 {text(row.item_id)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.price_points)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.min_price)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.max_price)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.units)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.elasticity)}</td></tr>)}</tbody></DataTable><p className="mt-2 text-xs leading-5 text-muted-foreground">这里反映的是成交价格与购买量的演示关系，不是价格实验结论；调价前仍需结合活动、流量和利润一起判断。</p></div> : null}
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
    for (const key of ['dimension', 'value', 'page', 'stage'] as const) {
      if (params?.[key]) canonicalQuery.set(key, params[key]);
    }
    redirect(`/analytics-workbench?${canonicalQuery.toString()}`);
  }
  const datasetId = requestedDatasetId;
  const view = Object.keys(VIEW_LABELS).includes(params?.view || '') ? params?.view as Exclude<View, 'drilldown'> : 'overview';
  const requestedLifecyclePage = Number.parseInt(params?.page || '1', 10);
  const lifecyclePage = Number.isFinite(requestedLifecyclePage) && requestedLifecyclePage > 0 ? requestedLifecyclePage : 1;
  const requestedLifecycleStage = params?.stage || '';
  const lifecycleStage = LIFECYCLE_STAGE_OPTIONS.some((option) => option.value === requestedLifecycleStage)
    ? requestedLifecycleStage
    : '';
  const lifecycleQuery = new URLSearchParams({
    dataset_id: datasetId,
    limit: '20',
    page: String(lifecyclePage),
  });
  if (lifecycleStage) lifecycleQuery.set('stage', lifecycleStage);
  const [overview, rfm, channels, profit, inventory, lifecycle, elasticity] = await Promise.all([
    fetchAnalytics(`/api/v1/commerce/analytics/overview?dataset_id=${encodeURIComponent(datasetId)}`),
    fetchAnalytics(`/api/v1/commerce/analytics/rfm?dataset_id=${encodeURIComponent(datasetId)}&limit=20`),
    fetchAnalytics(`/api/v1/commerce/analytics/channel-campaign?dataset_id=${encodeURIComponent(datasetId)}`),
    fetchAnalytics(`/api/v1/commerce/analytics/profit?dataset_id=${encodeURIComponent(datasetId)}`),
    fetchAnalytics(`/api/v1/commerce/analytics/inventory?dataset_id=${encodeURIComponent(datasetId)}&limit=20`),
    fetchAnalytics(`/api/v1/commerce/analytics/lifecycle?${lifecycleQuery.toString()}`),
    fetchAnalytics(`/api/v1/commerce/analytics/price-elasticity?dataset_id=${encodeURIComponent(datasetId)}`),
  ]);
  const contract = asRecord(overview?.contract);
  const metrics = asRecord(overview?.metrics);
  const quality = asRecord(overview?.quality);
  const contractWindow = `${text(contract?.window_start)} ~ ${text(contract?.window_end)}`;
  const tabs = (Object.entries(VIEW_LABELS) as Array<[Exclude<View, 'drilldown'>, string]>).map(([key, label]) => ({
    href: hrefFor(key, datasetId),
    label,
    active: view === key,
  }));

  let drilldown: JsonRecord | null = null;
  if (params?.view === 'drilldown' && params.dimension && params.value) {
    drilldown = await fetchAnalytics(`/api/v1/commerce/analytics/drilldown?dataset_id=${encodeURIComponent(datasetId)}&dimension=${encodeURIComponent(params.dimension)}&value=${encodeURIComponent(params.value)}`);
  }
  const lifecycleTotal = number(lifecycle?.filtered_item_count);
  const lifecyclePageCount = Math.max(number(lifecycle?.page_count), 1);
  const lifecycleCurrentPage = Math.max(number(lifecycle?.page) || 1, 1);

  return (
    <RetailPageShell
      title="经营分析 BI"
      subtitle={`数据集 ${datasetId} · 窗口 ${contractWindow}`}
      badge={<SyntheticBadge />}
      tabs={tabs}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/75 p-4 shadow-sm">
        <div><p className="text-sm font-semibold">从总览到下钻</p><p className="mt-1 text-xs text-muted-foreground">先看经营结果，再沿用户、渠道、利润、库存和商品阶段定位原因。</p></div>
        <div className="flex flex-wrap gap-2 text-xs"><Link href="/commerce-platform" className="rounded-lg bg-muted px-3 py-2 hover:text-foreground">商品运营</Link><Link href="/operations-briefing" className="rounded-lg bg-muted px-3 py-2 hover:text-foreground">经营情报</Link><span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">质量：{text(quality?.severity, '未扫描')}</span></div>
      </div>

      <DatasetSelector
        contracts={datasetContracts}
        selectedDatasetId={datasetId}
        view={params?.view === 'drilldown' ? 'drilldown' : view}
        dimension={params?.dimension}
        value={params?.value}
        apiBaseUrl={API_BASE_URL}
      />

      {!overview ? <Panel title="暂时无法读取经营分析数据"><p className="text-sm text-destructive">commerce-data 未返回扩展数据集，请确认服务已启动且 dataset_id 有效。</p></Panel> : null}

      {view === 'overview' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Metric label="订单数" value={displayNumber(metrics?.orders)} hint="扩展数据集订单记录" /><Metric label="有订单用户" value={displayNumber(metrics?.buyers)} hint="去重用户数" /><Metric label="销售件数" value={displayNumber(metrics?.units)} hint="订单商品数量" /><Metric label="估算销售额" value={displayMoney(metrics?.net_sales)} hint="演示数据的订单价格合计" /><Metric label="估算毛利" value={displayMoney(asRecord(profit?.total)?.gross_profit)} hint="估算销售额减演示成本" /></div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="用户分群" description="用最近购买、购买次数和订单净金额帮助定位用户经营重点。"><div className="grid grid-cols-2 gap-3">{Object.entries(asRecord(rfm?.segment_counts) ?? {}).map(([label, value]) => <Link key={label} href={hrefFor('customers', datasetId)} className="rounded-xl border border-border/60 bg-muted/30 p-3 hover:border-primary/40"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{displayNumber(value)}</p><p className="mt-1 text-[11px] text-muted-foreground">查看用户明细 →</p></Link>)}</div></Panel>
            <Panel title="库存健康" description="可售天数只用于识别库存结构，不直接等于补货指令。"><div className="grid grid-cols-2 gap-3">{Object.entries(asRecord(inventory?.risk_counts) ?? {}).map(([label, value]) => <Link key={label} href={hrefFor('inventory', datasetId)} className="rounded-xl border border-border/60 bg-muted/30 p-3 hover:border-primary/40"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{displayNumber(value)}</p><p className="mt-1 text-[11px] text-muted-foreground">查看库存明细 →</p></Link>)}</div></Panel>
          </div>
          <Panel title="渠道与活动贡献" description="这里是合成会话归因，不代表广告平台真实归因。"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">活动</th><th className="px-3 py-3">会话</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">订单转化率</th><th className="px-3 py-3">净销售额</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(channels?.metrics).slice(0, 6).map((row, index) => <tr key={`${String(row.channel_id)}-${index}`} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">{text(row.channel_name)}</td><td className="px-3 py-3 text-sm">{text(row.campaign_name)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.sessions)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.order_conversion)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td></tr>)}</tbody></DataTable></Panel>
          <div className="grid gap-5 lg:grid-cols-2"><Panel title="商品阶段" description="根据窗口内购买活跃度推断，不等于真实上架/下架生命周期。"><div className="grid grid-cols-2 gap-2">{Object.entries(asRecord(lifecycle?.stage_counts) ?? {}).map(([label, value]) => <Link key={label} href={hrefFor('lifecycle', datasetId)} className="flex items-center justify-between rounded-lg bg-muted/35 px-3 py-2 text-sm hover:bg-muted"><span>{label}</span><strong>{displayNumber(value)}</strong></Link>)}</div></Panel><Panel title="价格与成交关系" description="只有同一商品出现多个成交价格时，才提供价格弹性参考。"><Link href={hrefFor('elasticity', datasetId)} className="block rounded-xl border border-border/60 bg-muted/20 p-4 text-sm hover:border-primary/50"><span>{elasticity?.status === 'estimated' ? `平均价格弹性 ${text(elasticity?.elasticity_estimate)}` : '当前数据还不能估算价格弹性'}</span><span className="mt-2 block text-xs font-semibold">查看价格带与商品观察 →</span></Link></Panel></div>
          <Limitations payload={overview} />
        </div>
      ) : null}

      {view === 'customers' ? <Panel title="用户分群（RFM）" description="RFM 是用户分析简称；页面用“最近购买、购买次数、订单金额”解释，不要求用户理解缩写。"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">用户</th><th className="px-3 py-3">分群</th><th className="px-3 py-3">最近购买距今天数</th><th className="px-3 py-3">订单数</th><th className="px-3 py-3">订单净金额</th><th className="px-3 py-3">用户属性</th><th className="px-3 py-3">下钻</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(rfm?.customers).map((row) => <tr key={String(row.user_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">用户 {text(row.user_id)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.segment)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.recency_days)} 天</td><td className="px-3 py-3 text-sm">{displayNumber(row.frequency)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.monetary)}</td><td className="px-3 py-3 text-sm text-muted-foreground">{text(row.age_band)} · {text(row.city_tier)} · {text(row.member_level)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'user', row.user_id)}>继续查看</Link></td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={rfm} /></div></Panel> : null}

      {view === 'channels' ? <Panel title="渠道与活动归因" description="订单转化率 = 订单数 ÷ 会话数；这是演示会话归因，不是平台广告归因。"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">活动</th><th className="px-3 py-3">渠道类型</th><th className="px-3 py-3">会话</th><th className="px-3 py-3">独立用户</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">订单转化率</th><th className="px-3 py-3">净销售额</th><th className="px-3 py-3">下钻</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(channels?.metrics).map((row, index) => <tr key={`${String(row.channel_id)}-${String(row.campaign_id)}-${index}`} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">{text(row.channel_name)}</td><td className="px-3 py-3 text-sm">{text(row.campaign_name)}</td><td className="px-3 py-3 text-sm text-muted-foreground">{text(row.channel_type)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.sessions)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.users)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.order_conversion)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'channel', row.channel_id)}>继续查看</Link></td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={channels} /></div></Panel> : null}

      {view === 'profit' ? <Panel title="毛利分析" description="毛利 = 销售额 - 成本；这里是演示数据估算，不是财务结算报表。"><div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5"><Metric label="销售额" value={displayMoney(asRecord(profit?.total)?.gross_sales)} hint="订单价格合计" /><Metric label="退款" value={displayMoney(asRecord(profit?.total)?.refunds)} hint="演示退款金额" /><Metric label="成本" value={displayMoney(asRecord(profit?.total)?.cost)} hint="演示商品成本" /><Metric label="毛利" value={displayMoney(asRecord(profit?.total)?.gross_profit)} hint="销售额减退款和成本" /><Metric label="毛利率" value={displayPercent(asRecord(profit?.total)?.gross_margin)} hint="毛利 ÷ 销售额" /></div><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">渠道</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">销售额</th><th className="px-3 py-3">退款</th><th className="px-3 py-3">成本</th><th className="px-3 py-3">毛利</th><th className="px-3 py-3">毛利率</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(profit?.by_channel).map((row) => <tr key={String(row.channel_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">{text(row.channel_name)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.gross_sales)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.refunds)}</td><td className="px-3 py-3 text-sm">{displayMoney(row.cost)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.gross_profit)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.gross_margin)}</td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={profit} /></div></Panel> : null}

      {view === 'inventory' ? <Panel title="库存健康" description="可售天数 = 结存库存 ÷ 平均日销量；无销量商品单独标记。"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">健康判断</th><th className="px-3 py-3">结存库存</th><th className="px-3 py-3">平均日销量</th><th className="px-3 py-3">可售天数</th><th className="px-3 py-3">窗口销量</th><th className="px-3 py-3">下钻</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(inventory?.items).map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">商品 {text(row.item_id)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.health_label)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.closing_stock)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.average_daily_sold, 2)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.days_cover, 1)} 天</td><td className="px-3 py-3 text-sm">{displayNumber(row.sold_units)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'item', row.item_id)}>继续查看</Link></td></tr>)}</tbody></DataTable><div className="mt-4"><Limitations payload={inventory} /></div></Panel> : null}

      {view === 'lifecycle' ? <Panel title="商品经营阶段" description="这里展示全部商品，每页 20 个。阶段是根据购买记录推断的经营状态，不等于真实上架或下架生命周期。">
        <div className="mb-5 rounded-xl border border-border/60 bg-muted/20 p-4">
          <p className="text-sm font-semibold">选择要查看的阶段</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">点击下面的阶段即可筛选商品；数量是当前数据集中的全部商品数。</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {LIFECYCLE_STAGE_OPTIONS.map((option) => {
              const active = lifecycleStage === option.value;
              const count = option.value ? asRecord(lifecycle?.stage_counts)?.[option.label] : lifecycle?.item_count;
              return <Link key={option.value || 'all'} href={lifecycleHref(datasetId, 1, option.value)} className={`rounded-xl border p-3 transition-colors ${active ? 'border-primary bg-primary/10' : 'border-border/60 bg-card hover:border-primary/50'}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{option.label}</span><strong className="text-lg">{displayNumber(count)}</strong></div><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{option.description}</p></Link>;
            })}
          </div>
        </div>
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><p className="font-semibold">判断规则</p><ul className="mt-2 grid gap-1 text-xs leading-5 sm:grid-cols-2"><li>未启动：窗口内没有购买记录。</li><li>成长期：最近 14 天才开始购买，或活跃时间还不长。</li><li>稳定期：购买活跃持续至少 14 天。</li><li>衰退风险：距离最近一次购买超过 14 天。</li></ul><p className="mt-2 text-xs leading-5 text-sky-900/80">这些规则只根据当前数据窗口内的购买记录判断；如果没有真实上架、下架、补货和停售事件，就不能把它当成商品真实生命周期。</p></div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span>当前查看：{lifecycleStage || '全部商品'}，共 {displayNumber(lifecycleTotal)} 个商品</span><span className="text-xs text-muted-foreground">第 {displayNumber(lifecycleCurrentPage)} / {displayNumber(lifecyclePageCount)} 页，每页 20 个</span></div>
        <DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">商品</th><th className="px-3 py-3">阶段</th><th className="px-3 py-3">首次购买</th><th className="px-3 py-3">最近购买</th><th className="px-3 py-3">活跃天数</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">估算销售额</th><th className="px-3 py-3">下钻</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(lifecycle?.items).map((row) => <tr key={String(row.item_id)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm">商品 {text(row.item_id)}</td><td className="px-3 py-3 text-sm font-semibold">{text(row.stage)}</td><td className="px-3 py-3 text-sm">{text(row.first_order_date, '暂无购买')}</td><td className="px-3 py-3 text-sm">{text(row.last_order_date, '暂无购买')}</td><td className="px-3 py-3 text-sm">{row.active_days === null ? '-' : displayNumber(row.active_days)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm"><Link className="text-primary hover:underline" href={drilldownHref(datasetId, 'item', row.item_id)}>继续查看</Link></td></tr>)}</tbody></DataTable>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Link href={lifecycleCurrentPage > 1 ? lifecycleHref(datasetId, lifecycleCurrentPage - 1, lifecycleStage) : lifecycleHref(datasetId, lifecycleCurrentPage, lifecycleStage)} aria-disabled={lifecycleCurrentPage <= 1} className={`rounded-lg border px-3 py-2 text-sm ${lifecycleCurrentPage <= 1 ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>上一页</Link><div className="flex items-center gap-1 text-xs text-muted-foreground">第 {displayNumber(lifecycleCurrentPage)} 页，共 {displayNumber(lifecyclePageCount)} 页</div><Link href={lifecycleCurrentPage < lifecyclePageCount ? lifecycleHref(datasetId, lifecycleCurrentPage + 1, lifecycleStage) : lifecycleHref(datasetId, lifecycleCurrentPage, lifecycleStage)} aria-disabled={lifecycleCurrentPage >= lifecyclePageCount} className={`rounded-lg border px-3 py-2 text-sm ${lifecycleCurrentPage >= lifecyclePageCount ? 'pointer-events-none border-border/40 text-muted-foreground/50' : 'border-border/70 hover:border-primary/50'}`}>下一页</Link></div>
        <div className="mt-4"><Limitations payload={lifecycle} /></div>
      </Panel> : null}

      {view === 'elasticity' ? <Panel title="价格带对比与价格弹性参考" description="价格带用于比较商品价格结构；有多个成交价格观察时，额外展示价格与购买量的关系参考。"><ElasticitySummary payload={elasticity} /><div className="mt-5"><DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground"><th className="px-3 py-3">价格带</th><th className="px-3 py-3">商品数</th><th className="px-3 py-3">订单</th><th className="px-3 py-3">销售件数</th><th className="px-3 py-3">估算销售额</th><th className="px-3 py-3">平均折扣</th></tr></thead><tbody className="divide-y divide-border/60">{asArray(elasticity?.price_band_comparison).map((row) => <tr key={String(row.price_band)} className="hover:bg-muted/35"><td className="px-3 py-3 text-sm font-semibold">¥{text(row.price_band)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.item_count)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.orders)}</td><td className="px-3 py-3 text-sm">{displayNumber(row.units)}</td><td className="px-3 py-3 text-sm font-semibold">{displayMoney(row.net_sales)}</td><td className="px-3 py-3 text-sm">{displayPercent(row.average_discount_rate)}</td></tr>)}</tbody></DataTable></div><div className="mt-4"><Limitations payload={elasticity} /></div></Panel> : null}

      {params?.view === 'drilldown' ? <Panel title="继续下钻" description="当前上下文由上一个分析动作带入；下面的提示可以作为下一轮 Agent 问题。"><div className="rounded-xl bg-muted/35 p-4 text-sm"><span className="text-muted-foreground">下钻条件：</span>{text(DIMENSION_LABELS[text(drilldown?.context && asRecord(drilldown.context)?.dimension)] || text(drilldown?.context && asRecord(drilldown.context)?.dimension))} = {text(drilldown?.context && asRecord(drilldown.context)?.value, params.value || '-')}</div>{drilldown ? <DataTable><thead className="bg-muted/60"><tr className="text-left text-xs font-semibold text-muted-foreground">{Object.keys(asArray(drilldown.results)[0] ?? {}).map((key) => <th key={key} className="px-3 py-3">{DRILLDOWN_LABELS[key] || key}</th>)}</tr></thead><tbody className="divide-y divide-border/60">{asArray(drilldown.results).map((row, index) => <tr key={index}>{Object.entries(row).map(([key, value]) => <td key={key} className="px-3 py-3 text-sm">{typeof value === 'number' && /sales|amount|profit|cost/i.test(key) ? displayMoney(value) : text(value)}</td>)}</tr>)}</tbody></DataTable> : <p className="mt-4 text-sm text-destructive">没有找到下钻结果。</p>}<div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">下一步可以继续问</p><div className="flex flex-wrap gap-2">{asStringArray(drilldown?.next_questions).map((question) => <span key={question} className="rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary">{question}</span>)}</div></div><div className="mt-4"><Limitations payload={drilldown} /></div></Panel> : null}
    </RetailPageShell>
  );
}
