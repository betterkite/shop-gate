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

  const meta = await fetchJson<Record<string, unknown>>('/api/v1/commerce/meta');
  const window = {
    start: isoDay(meta?.first_event_ts, '2017-11-25'),
    end: isoDay(meta?.last_event_ts, '2017-12-03'),
  };
  const behaviorSource =
    typeof meta?.behavior_source === 'string' ? (meta.behavior_source as string) : 'unknown';

  const pageSize = 20;
  const itemsResult = await fetchJson<Record<string, unknown>>(
    `/api/v1/commerce/items?start=${window.start}&end=${window.end}&page=${page}&page_size=${pageSize}&sort=${sort}`,
  );
  const items = Array.isArray(itemsResult?.items)
    ? (itemsResult.items as Record<string, unknown>[])
    : [];
  const itemsTotal =
    typeof itemsResult?.total === 'number' ? (itemsResult.total as number) : 0;

  const categories = (await fetchJson<Record<string, unknown>[]>(
    `/api/v1/commerce/categories/top?start=${window.start}&end=${window.end}&metric=gmv&limit=100`,
  )) ?? [];

  const channels = (await fetchJson<Record<string, unknown>[]>(
    `/api/v1/commerce/channels?start=${window.start}&end=${window.end}`,
  )) ?? [];

  return {
    view,
    window,
    behaviorSource,
    meta,
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
