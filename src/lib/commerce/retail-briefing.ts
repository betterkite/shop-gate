import { getRuntimeDegradationConfig } from '@/lib/config/degradation';

const BASE_URL =
  process.env.SHOPGATE_MARKET_API_URL ||
  process.env.SHOPGATE_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

export type OperationsBriefingView = 'daily' | 'categories' | 'watch';

export interface OperationsBriefingData {
  view: OperationsBriefingView;
  window: { start: string; end: string };
  behaviorSource: string;
  daily: Record<string, unknown> | null;
  categories: Record<string, unknown>[];
  watch: Record<string, unknown>[];
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

function isoDay(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : fallback;
}

export async function getOperationsBriefingData(params: {
  view?: string;
}): Promise<OperationsBriefingData> {
  const view: OperationsBriefingView =
    params.view === 'categories' || params.view === 'watch' ? params.view : 'daily';

  const meta = await fetchJson<Record<string, unknown>>('/api/v1/commerce/meta');
  const window = {
    start: isoDay(meta?.first_event_ts, '2017-11-25'),
    end: isoDay(meta?.last_event_ts, '2017-12-03'),
  };
  const behaviorSource =
    typeof meta?.behavior_source === 'string' ? (meta.behavior_source as string) : 'unknown';

  // 经营日报：取窗口末日快照（含日环比）。
  const daily = await fetchJson<Record<string, unknown>>(
    `/api/v1/commerce/summary?date=${window.end}`,
  );

  // 类目经营榜：窗口内 top 类目。
  const categories = (await fetchJson<Record<string, unknown>[]>(
    `/api/v1/commerce/categories/top?start=${window.start}&end=${window.end}&metric=gmv&limit=100`,
  )) ?? [];

  // 观察池：窗口内 top 商品。
  const watchResult = await fetchJson<Record<string, unknown>>(
    `/api/v1/commerce/items?start=${window.start}&end=${window.end}&page=1&page_size=20&sort=gmv`,
  );
  const watch = Array.isArray(watchResult?.items)
    ? (watchResult.items as Record<string, unknown>[])
    : [];

  return {
    view,
    window,
    behaviorSource,
    daily,
    categories,
    watch,
    apiEnabled: getRuntimeDegradationConfig().components.marketApi.enabled,
    updatedAt: new Date().toISOString(),
  };
}
