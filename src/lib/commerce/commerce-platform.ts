import { getRuntimeDegradationConfig } from '@/lib/config/degradation';

const BASE_URL =
  process.env.SHOPGATE_MARKET_API_URL ||
  process.env.SHOPGATE_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

export type CommercePlatformView =
  | 'products'
  | 'categories'
  | 'channels';

export const COMMERCE_PLATFORM_SORTS = ['gmv', 'pv', 'buy', 'price'] as const;
export type CommercePlatformSort = (typeof COMMERCE_PLATFORM_SORTS)[number];

export interface CommercePlatformData {
  view: CommercePlatformView;
  window: { start: string; end: string };
  behaviorSource: string;
  meta: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  items: Record<string, unknown>[];
  itemsTotal: number;
  page: number;
  pageSize: number;
  sort: CommercePlatformSort;
  categories: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  apiEnabled: boolean;
  updatedAt: string;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const degradation = getRuntimeDegradationConfig().components.marketApi;
  if (!degradation.enabled) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function text(value: unknown, fallback = '-'): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isoDay(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : fallback;
}

export function isCommercePlatformSort(value: string | undefined): value is CommercePlatformSort {
  return COMMERCE_PLATFORM_SORTS.includes(value as CommercePlatformSort);
}

const DEFAULT_WINDOW = { start: '2017-11-25', end: '2017-12-03' };
const WINDOW_TTL_MS = 5 * 60_000;
let cachedWindow: { start: string; end: string; behaviorSource: string; at: number } | null = null;

/** 窗口与行为来源不会随每次切 tab/排序变化，缓存避免重复打最慢的 /meta。 */
async function resolveWindow(): Promise<{ start: string; end: string; behaviorSource: string }> {
  if (cachedWindow && Date.now() - cachedWindow.at < WINDOW_TTL_MS) {
    return { start: cachedWindow.start, end: cachedWindow.end, behaviorSource: cachedWindow.behaviorSource };
  }
  const meta = await fetchJson<Record<string, unknown>>('/api/v1/commerce/meta');
  const resolved = {
    start: isoDay(meta?.first_event_ts, DEFAULT_WINDOW.start),
    end: isoDay(meta?.last_event_ts, DEFAULT_WINDOW.end),
    behaviorSource:
      typeof meta?.behavior_source === 'string' ? (meta.behavior_source as string) : 'unknown',
  };
  cachedWindow = { ...resolved, at: Date.now() };
  return resolved;
}

export async function getCommercePlatformData(params: {
  view?: string;
  page?: string;
  sort?: string;
}): Promise<CommercePlatformData> {
  const view: CommercePlatformView =
    params.view === 'categories' || params.view === 'channels' ? params.view : 'products';
  const sort: CommercePlatformSort =
    isCommercePlatformSort(params.sort) ? params.sort : 'gmv';
  const page = clampInteger(Number(params.page) || 1, 1, 1_000_000);
  const pageSize = 20;

  const { start, end, behaviorSource } = await resolveWindow();
  const window = { start, end };

  // 只拉当前视图需要的数据集，避免切换标签时把全部 4 个接口都重新请求一遍。
  let items: Record<string, unknown>[] = [];
  let itemsTotal = 0;
  let categories: Record<string, unknown>[] = [];
  let channels: Record<string, unknown>[] = [];
  const summary = await fetchJson<Record<string, unknown>>(`/api/v1/commerce/summary?date=${end}`);

  if (view === 'products') {
    const itemsResult = await fetchJson<Record<string, unknown>>(
      `/api/v1/commerce/items?start=${start}&end=${end}&page=${page}&page_size=${pageSize}&sort=${sort}`,
    );
    items = Array.isArray(itemsResult?.items)
      ? (itemsResult.items as Record<string, unknown>[])
      : [];
    itemsTotal = typeof itemsResult?.total === 'number' ? (itemsResult.total as number) : 0;
  } else if (view === 'categories') {
    categories = (await fetchJson<Record<string, unknown>[]>(
      `/api/v1/commerce/categories/top?start=${start}&end=${end}&metric=gmv&limit=100`,
    )) ?? [];
  } else {
    channels = (await fetchJson<Record<string, unknown>[]>(
      `/api/v1/commerce/channels?start=${start}&end=${end}`,
    )) ?? [];
  }

  return {
    view,
    window,
    behaviorSource,
    meta: null,
    summary,
    items,
    itemsTotal,
    page,
    pageSize,
    sort,
    categories,
    channels,
    apiEnabled: getRuntimeDegradationConfig().components.marketApi.enabled,
    updatedAt: new Date().toISOString(),
  };
}

export function displayNumber(value: unknown, digits = 2): string {
  const parsed = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : null;
  if (parsed === null || !Number.isFinite(parsed)) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(parsed);
}

export function displayMoney(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return '¥' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(parsed);
}

export function displayPercent(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return '-';
  const ratio = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(ratio) + '%';
}

export { text };
