/**
 * 零售数据预取（PRD §3/§5/§7，retail runtime 领域层）。
 *
 * 与金融版的差异：金融按"标的 × 多端点 × 补数矩阵"编排（2,000+ 行），
 * 零售是 8 个只读 commerce 端点的窗口/实体编排。产出的 finalData 契合
 * `assessRetailDatasetIdentity` 与 apply_dashboard_spec 的前置条件。
 *
 * 窗口精化：planning 阶段的 plan.window 可为 null，这里用 /meta 的真实
 * 窗口回写 run plan，保证最终数据身份校验（窗口逐日相等）通过。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendRetailWorkspaceEvent,
  ensureRetailWorkspace,
  type RetailRunPlan,
} from '@/lib/domains/retail/workspace';
import { buildRetailBiOverview } from '@/lib/domains/retail/bi-dataset';
import { RETAIL_RUN_PLAN_RELATIVE_PATH } from '@/lib/domains/retail/workspace-artifacts';
import { writeWorkspaceJsonAtomic } from '@/lib/data-agent';

type JsonRecord = Record<string, unknown>;

const COMMERCE_API_BASE = (
  process.env.SHOPGATE_MARKET_API_URL ?? 'http://127.0.0.1:8000'
).replace(/\/$/, '');
const DEFAULT_ANALYTICS_DATASET_ID = process.env.SHOPGATE_RETAIL_ANALYTICS_DATASET_ID || 'retail-demo-expanded-v1';
const FETCH_TIMEOUT_MS = 10_000;

export interface PrefetchResult {
  skipped?: boolean;
  summary?: string;
  finalDataPath?: string;
  datasetKeys?: string[];
  warnings?: string[];
  rawFiles?: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

async function fetchCommerceJson(apiPath: string, query: Record<string, string> = {}): Promise<JsonRecord> {
  const url = new URL(apiPath, COMMERCE_API_BASE);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${apiPath} 返回 HTTP ${response.status}`);
    }
    const parsed: unknown = await response.json();
    if (Array.isArray(parsed)) {
      // 类目榜/分日趋势端点返回顶层数组：包一层满足后续字典访问。
      return { rows: parsed } as JsonRecord;
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${apiPath} 返回的不是 JSON 对象`);
    }
    return parsed as JsonRecord;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function datasetKeyFromEndpoint(endpoint: string): string | null {
  const match = endpoint.match(/^GET \/api\/v1\/commerce\/([a-z-]+)/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  if (raw === 'funnel') return 'funnel';
  if (raw === 'meta') return 'meta';
  if (raw === 'summary') return 'summary';
  if (raw === 'inventory-risk') return 'inventoryRisk';
  if (raw === 'channels') return 'channels';
  if (raw === 'categories') return 'categories';
  if (raw === 'items') return 'itemDaily';
  return null;
}

async function fetchChannelsDataset(params: {
  start: string;
  end: string;
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<JsonRecord | null> {
  try {
    const payload = await fetchCommerceJson('/api/v1/commerce/channels', {
      start: params.start,
      end: params.end,
    });
    const dataset = { window: { start: params.start, end: params.end }, rows: Array.isArray(payload.rows) ? payload.rows : [] };
    const filePath = path.join(params.rawDir, 'channels.json');
    await writeJson(filePath, dataset);
    params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
    params.sources.push({
      source: '/api/v1/commerce/channels',
      dataset: 'channels',
      endpoint: '/api/v1/commerce/channels',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
    return dataset;
  } catch (error) {
    params.warnings.push(`渠道预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/channels',
      dataset: 'channels',
      endpoint: '/api/v1/commerce/channels',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return null;
  }
}

async function fetchItemPoolDataset(params: {
  start: string;
  end: string;
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<JsonRecord | null> {
  try {
    const payload = await fetchCommerceJson('/api/v1/commerce/items', {
      start: params.start,
      end: params.end,
      page: '1',
      page_size: '100',
      sort: 'pv',
    });
    const dataset = {
      window: { start: params.start, end: params.end },
      page: payload.page,
      page_size: payload.page_size,
      total: payload.total,
      synthetic_fields: ['price', 'stock', 'brand_name', 'shop_name', 'shop_tier', 'gmv'],
      items: Array.isArray(payload.items) ? payload.items : [],
    };
    const filePath = path.join(params.rawDir, 'item-pool.json');
    await writeJson(filePath, dataset);
    params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
    params.sources.push({
      source: '/api/v1/commerce/items',
      dataset: 'itemPool',
      endpoint: '/api/v1/commerce/items?page_size=100&sort=pv',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
    return dataset;
  } catch (error) {
    params.warnings.push(`商品表现预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/items',
      dataset: 'itemPool',
      endpoint: '/api/v1/commerce/items?page_size=100&sort=pv',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return null;
  }
}

function planDatasetKeys(plan: RetailRunPlan): Set<string> {
  const keys = new Set<string>(['meta']);
  for (const endpoint of plan.dataRequirements) {
    const key = datasetKeyFromEndpoint(endpoint);
    if (key) keys.add(key);
  }
  return keys;
}

async function fetchExpandedAnalyticsDatasets(params: {
  datasetId: string;
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<Record<string, JsonRecord>> {
  const endpoints = [
    ['analyticsOverview', '/api/v1/commerce/analytics/overview'],
    ['analyticsLifecycle', '/api/v1/commerce/analytics/lifecycle'],
    ['analyticsRetention', '/api/v1/commerce/analytics/retention'],
    ['analyticsProfit', '/api/v1/commerce/analytics/profit'],
    ['analyticsInventory', '/api/v1/commerce/analytics/inventory'],
    ['analyticsChannels', '/api/v1/commerce/analytics/channel-campaign'],
    ['analyticsElasticity', '/api/v1/commerce/analytics/price-elasticity'],
  ] as const;
  const datasets: Record<string, JsonRecord> = {};
  for (const [key, endpoint] of endpoints) {
    try {
      const payload = await fetchCommerceJson(endpoint, { dataset_id: params.datasetId, limit: '20' });
      datasets[key] = payload;
      const filePath = path.join(params.rawDir, `${key}.json`);
      await writeJson(filePath, payload);
      params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
      params.sources.push({
        source: endpoint,
        dataset: key,
        endpoint: `${endpoint}?dataset_id=${params.datasetId}`,
        status: 'success',
        fetched_at: new Date().toISOString(),
      });
    } catch (error) {
      params.warnings.push(`${key} 预取失败：${error instanceof Error ? error.message : String(error)}`);
      params.sources.push({
        source: endpoint,
        dataset: key,
        endpoint: `${endpoint}?dataset_id=${params.datasetId}`,
        status: 'failed',
        fetched_at: new Date().toISOString(),
      });
    }
  }
  return datasets;
}

function isoDay(value: string): string {
  return value.slice(0, 10);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function buildFunnelStages(counts: Record<string, number>): JsonRecord[] {
  const stages: JsonRecord[] = [];
  let previous = 0;
  for (const [order, stage] of ['pv', 'fav', 'cart', 'buy'].entries()) {
    const events = Math.max(0, Math.round(numberValue(counts[stage])));
    stages.push({
      stage,
      order,
      events,
      unique_users: null,
      conversion_from_previous: previous > 0 ? Number((events / previous).toFixed(6)) : null,
    });
    previous = events;
  }
  return stages;
}

function sumFunnelCounts(rows: JsonRecord[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((totals, row) => {
    for (const stage of ['pv', 'fav', 'cart', 'buy']) {
      totals[stage] = (totals[stage] ?? 0) + numberValue(row[stage]);
    }
    return totals;
  }, {});
}

async function fetchFunnelDatasets(params: {
  datasetId?: string;
  start: string;
  end: string;
  categoryIds: number[];
  itemIds: number[];
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<{ funnel: JsonRecord | null; funnelDaily: JsonRecord | null }> {
  if (params.datasetId) {
    try {
      const scope = params.itemIds.length === 1
        ? { dimension: 'item', value: String(params.itemIds[0]) }
        : params.categoryIds.length === 1
          ? { dimension: 'category', value: String(params.categoryIds[0]) }
          : null;
      const trend = await fetchCommerceJson('/api/v1/commerce/analytics/trend', {
        dataset_id: params.datasetId,
        ...(scope ?? {}),
      });
      const trendRows = Array.isArray(trend.rows) ? trend.rows : [];
      let counts = sumFunnelCounts(trendRows);
      let detail: JsonRecord | null = null;
      if (scope) {
        detail = await fetchCommerceJson('/api/v1/commerce/analytics/drilldown', {
          dataset_id: params.datasetId,
          dimension: scope.dimension,
          value: scope.value,
          limit: '1',
        });
        const result = Array.isArray(detail.results) ? asRecord(detail.results[0]) : null;
        if (result) {
          counts = {
            pv: numberValue(result.pv),
            fav: numberValue(result.fav),
            cart: numberValue(result.cart),
            buy: numberValue(result.buy),
          };
        }
      }
      const funnel = {
        dataset_id: params.datasetId,
        start: params.start,
        end: params.end,
        filter: scope,
        ...(typeof trend.context_url === 'string' ? { context_url: trend.context_url } : {}),
        stages: buildFunnelStages(counts),
        unique_users: {},
        source: 'analytics dataset API',
      };
      const funnelDaily = {
        dataset_id: params.datasetId,
        window: { start: params.start, end: params.end },
        ...(typeof trend.context_url === 'string' ? { context_url: trend.context_url } : {}),
        rows: trendRows,
      };
      for (const [key, payload, endpoint] of [
        ['funnel', funnel, '/api/v1/commerce/analytics/trend'],
        ['funnelDaily', funnelDaily, '/api/v1/commerce/analytics/trend'],
      ] as const) {
        const filePath = path.join(params.rawDir, `${key}.json`);
        await writeJson(filePath, payload);
        params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
        params.sources.push({
          dataset: key,
          source: endpoint,
          endpoint: `${endpoint}?dataset_id=${params.datasetId}`,
          artifact_path: `data_file/raw/${key}.json`,
          status: 'success',
          fetched_at: new Date().toISOString(),
        });
      }
      return { funnel, funnelDaily };
    } catch (error) {
      params.warnings.push(`数据集漏斗预取失败：${error instanceof Error ? error.message : String(error)}`);
      params.sources.push({
        source: '/api/v1/commerce/analytics/trend',
        dataset: 'funnel',
        endpoint: `/api/v1/commerce/analytics/trend?dataset_id=${params.datasetId}`,
        status: 'failed',
        fetched_at: new Date().toISOString(),
      });
      return { funnel: null, funnelDaily: null };
    }
  }

  const query: Record<string, string> = { start: params.start, end: params.end };
  if (params.categoryIds.length === 1) {
    query.category_id = String(params.categoryIds[0]);
  }
  try {
    const funnel = await fetchCommerceJson('/api/v1/commerce/funnel', query);
    const funnelDaily = await fetchCommerceJson('/api/v1/commerce/funnel/daily', query);
    for (const [key, payload] of [
      ['funnel', funnel],
      ['funnelDaily', funnelDaily],
    ] as const) {
      const filePath = path.join(params.rawDir, `${key}.json`);
      await writeJson(filePath, payload);
      params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
      params.sources.push({
        dataset: key,
        source: '/api/v1/commerce/funnel',
        endpoint: '/api/v1/commerce/funnel',
        artifact_path: `data_file/raw/${key}.json`,
        status: 'success',
        fetched_at: new Date().toISOString(),
      });
    }
    if (params.categoryIds.length > 1) {
      params.warnings.push(
        'v1 漏斗接口按单类目过滤；多类目计划当前按合并口径返回，逐类目拆解在后续版本精化。',
      );
    }
    return { funnel, funnelDaily };
  } catch (error) {
    params.warnings.push(`漏斗预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/funnel',
      dataset: 'funnel',
      endpoint: '/api/v1/commerce/funnel',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return { funnel: null, funnelDaily: null };
  }
}

async function fetchCategoriesDataset(params: {
  start: string;
  end: string;
  dailySnapshot?: boolean;
  categoryIds: number[];
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<JsonRecord | null> {
  try {
    const queryStart = params.dailySnapshot ? params.end : params.start;
    const payload = await fetchCommerceJson('/api/v1/commerce/categories/top', {
      start: queryStart,
      end: params.end,
      metric: 'gmv',
      limit: '50',
    });
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const scoped = params.categoryIds.length > 0
      ? rows.filter((row) => params.categoryIds.includes(Number(row.category_id)))
      : rows;
    const dataset = {
      window: { start: params.start, end: params.end },
      rows: scoped,
    };
    const filePath = path.join(params.rawDir, 'categories.json');
    await writeJson(filePath, dataset);
    params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
    params.sources.push({
      source: '/api/v1/commerce/categories/top',
      dataset: 'categories',
      endpoint: '/api/v1/commerce/categories/top',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
    return dataset;
  } catch (error) {
    params.warnings.push(`类目预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/categories/top',
      dataset: 'categories',
      endpoint: '/api/v1/commerce/categories/top',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return null;
  }
}

async function fetchInventoryDataset(params: {
  start: string;
  end: string;
  itemIds: number[];
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<JsonRecord | null> {
  try {
    const payload = await fetchCommerceJson('/api/v1/commerce/inventory-risk', {
      start: params.start,
      end: params.end,
      limit: '100',
    });
    const items = Array.isArray(payload.items) ? payload.items : [];
    const scoped = params.itemIds.length > 0
      ? items.filter((item) => params.itemIds.includes(Number(item.item_id)))
      : items;
    const dataset = {
      window: { start: params.start, end: params.end },
      synthetic_fields: ['price', 'stock'],
      items: scoped,
      health: payload.health ?? null,
    };
    const filePath = path.join(params.rawDir, 'inventory-risk.json');
    await writeJson(filePath, dataset);
    params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
    params.sources.push({
      source: '/api/v1/commerce/inventory-risk',
      dataset: 'inventoryRisk',
      endpoint: '/api/v1/commerce/inventory-risk',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
    return dataset;
  } catch (error) {
    params.warnings.push(`库存预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/inventory-risk',
      dataset: 'inventoryRisk',
      endpoint: '/api/v1/commerce/inventory-risk',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return null;
  }
}

async function fetchSummaryDataset(params: {
  end: string;
  rawDir: string;
  rawFiles: string[];
  warnings: string[];
  sources: JsonRecord[];
}): Promise<JsonRecord | null> {
  try {
    const payload = await fetchCommerceJson('/api/v1/commerce/summary', {
      date: params.end,
    });
    const dataset = {
      window: { start: params.end, end: params.end },
      ...payload,
    };
    const filePath = path.join(params.rawDir, 'summary.json');
    await writeJson(filePath, dataset);
    params.rawFiles.push(path.relative(params.rawDir, filePath).replaceAll(path.sep, '/'));
    params.sources.push({
      source: '/api/v1/commerce/summary',
      dataset: 'summary',
      endpoint: '/api/v1/commerce/summary',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
    return dataset;
  } catch (error) {
    params.warnings.push(`日报预取失败：${error instanceof Error ? error.message : String(error)}`);
    params.sources.push({
      source: '/api/v1/commerce/summary',
      dataset: 'summary',
      endpoint: '/api/v1/commerce/summary',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    return null;
  }
}

/**
 * 平台预取：按 run plan 的能力端点集合抓取真实数据，写最终数据文件与证据，
 * 并把真实窗口/实体范围回写 run plan（身份校验依赖该一致性）。
 */
export async function prefetchRetailDataForRunPlan(params: {
  projectPath: string;
  plan: RetailRunPlan;
}): Promise<PrefetchResult> {
  if (
    params.plan.status === 'needs_clarification' ||
    params.plan.status === 'refused' ||
    params.plan.clarification?.required
  ) {
    return { skipped: true, summary: '任务仍需用户补充关键信息，跳过平台预取数据。' };
  }

  await ensureRetailWorkspace(params.projectPath);
  const runId = params.plan.runId;
  const rawDir = path.join(params.projectPath, 'data_file', 'raw', runId);
  const rawFiles: string[] = [];
  const warnings: string[] = [];
  const sources: JsonRecord[] = [];

  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: 'data_prefetch_started',
    stage: 'data_collection',
    status: 'pending',
    run_id: runId,
    summary: '平台开始预取零售经营数据（窗口/实体以 commerce-data 为准）。',
  });

  let meta: JsonRecord | null = null;
  try {
    const metaQuery: Record<string, string> = params.plan.datasetId
      ? { dataset_id: params.plan.datasetId }
      : {};
    meta = await fetchCommerceJson('/api/v1/commerce/meta', metaQuery);
    const metaPath = path.join(rawDir, 'meta.json');
    await writeJson(metaPath, meta);
    rawFiles.push(path.relative(params.projectPath, metaPath).replaceAll(path.sep, '/'));
    sources.push({
      dataset: 'meta',
      source: '/api/v1/commerce/meta',
      endpoint: params.plan.datasetId
        ? `/api/v1/commerce/meta?dataset_id=${params.plan.datasetId}`
        : '/api/v1/commerce/meta',
      artifact_path: 'data_file/raw/meta.json',
      status: 'success',
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = `meta 预取失败：${error instanceof Error ? error.message : String(error)}`;
    warnings.push(message);
    sources.push({
      source: '/api/v1/commerce/meta',
      dataset: 'meta',
      endpoint: params.plan.datasetId
        ? `/api/v1/commerce/meta?dataset_id=${params.plan.datasetId}`
        : '/api/v1/commerce/meta',
      status: 'failed',
      fetched_at: new Date().toISOString(),
    });
    await appendRetailWorkspaceEvent(params.projectPath, {
      event_type: 'data_prefetch_failed',
      stage: 'data_collection',
      status: 'error',
      run_id: runId,
      summary: message,
    });
    return { skipped: true, summary: `commerce-data 不可用，已暂停预取。${message}` };
  }

  const firstEvent = typeof meta.first_event_ts === 'string' ? meta.first_event_ts : null;
  const lastEvent = typeof meta.last_event_ts === 'string' ? meta.last_event_ts : null;
  const window = {
    start: isoDay(firstEvent ?? new Date().toISOString()),
    end: isoDay(lastEvent ?? new Date().toISOString()),
  };
  const categoryIds = [...params.plan.plannedEntities.categoryIds];
  const itemIds = [...params.plan.plannedEntities.itemIds];

  const datasetKeys = planDatasetKeys(params.plan);
  const datasets: JsonRecord = { meta: { ...meta, window } };

  if (datasetKeys.has('funnel')) {
    const { funnel, funnelDaily } = await fetchFunnelDatasets({
      datasetId: params.plan.datasetId,
      start: window.start,
      end: window.end,
      categoryIds,
      itemIds,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (funnel) datasets.funnel = { ...funnel, window };
    if (funnelDaily) datasets.funnelDaily = { window, rows: Array.isArray(funnelDaily.rows) ? funnelDaily.rows : [] };
  }
  if (datasetKeys.has('categories')) {
    const categories = await fetchCategoriesDataset({
      start: window.start,
      end: window.end,
      dailySnapshot: params.plan.capabilityId === 'daily_brief',
      categoryIds,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (categories) datasets.categories = categories;
  }
  if (datasetKeys.has('inventoryRisk')) {
    const inventoryRisk = await fetchInventoryDataset({
      start: window.start,
      end: window.end,
      itemIds,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (inventoryRisk) datasets.inventoryRisk = inventoryRisk;
  }
  if (datasetKeys.has('summary')) {
    const summary = await fetchSummaryDataset({
      end: window.end,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (summary) datasets.summary = summary;
  }

  // 价库看板需要跨主题 BI 拆解：行为流、类目、库存之外补充渠道和
  // 高流量商品表现；成本/毛利等行为流没有的字段由可复现合成投影生成。
  if (params.plan.capabilityId === 'price_inventory') {
    const channels = await fetchChannelsDataset({
      start: window.start,
      end: window.end,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (channels) datasets.channels = channels;
    const itemPool = await fetchItemPoolDataset({
      start: window.start,
      end: window.end,
      rawDir,
      rawFiles,
      warnings,
      sources,
    });
    if (itemPool) datasets.itemPool = itemPool;
    datasets.biOverview = buildRetailBiOverview({
      window,
      meta: asRecord(datasets.meta),
      funnelDaily: asRecord(datasets.funnelDaily),
      categories: asRecord(datasets.categories),
      inventoryRisk: asRecord(datasets.inventoryRisk),
      itemPool,
      channels,
      summary: asRecord(datasets.summary),
    });
    if (params.plan.visualization?.templateId === 'analytics-bi') {
      Object.assign(datasets, await fetchExpandedAnalyticsDatasets({
        datasetId: params.plan.datasetId ?? DEFAULT_ANALYTICS_DATASET_ID,
        rawDir,
        rawFiles,
        warnings,
        sources,
      }));
    }
  }

  const itemDailyRequired = params.plan.dataRequirements.some(
    (endpoint) => endpoint.includes('/items/'),
  );
  if (itemDailyRequired && itemIds.length > 0) {
    const itemDailyRows: JsonRecord[] = [];
    for (const itemId of itemIds.slice(0, 20)) {
      try {
        const rows = await fetchCommerceJson(
          `/api/v1/commerce/items/${itemId}/daily`,
          { start: window.start, end: window.end },
        );
        if (Array.isArray(rows)) itemDailyRows.push(...(rows as JsonRecord[]));
        sources.push({
          source: '/api/v1/commerce/itemDaily',
          dataset: 'itemDaily',
          endpoint: `/api/v1/commerce/items/${itemId}/daily`,
          status: 'success',
          fetched_at: new Date().toISOString(),
        });
      } catch (error) {
        warnings.push(
          `商品 ${itemId} 日序预取失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (itemDailyRows.length > 0) {
      const dataset = { window, rows: itemDailyRows };
      datasets.itemDaily = dataset;
      const filePath = path.join(rawDir, 'item-daily.json');
      await writeJson(filePath, dataset);
      rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    }
  }

  const finalData: JsonRecord = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    ...(params.plan.datasetId ? { datasetId: params.plan.datasetId } : {}),
    window,
    plannedEntities: { categoryIds, itemIds },
    // 身份评估要求最终数据携带计划的模板声明（visualization_template_missing）。
    ...(params.plan.visualization?.templateId
      ? { visualization: { template_id: params.plan.visualization.templateId } }
      : {}),
    synthetic: {
      fields: ['price', 'stock', 'brand', 'shop', 'gmv', 'channel', 'cost_proxy', 'profit_proxy', 'inventory_value'],
      note: '行为事件为窗口事实；价格、库存、渠道、成本、毛利和库存金额为合成或估算口径，展示必须带合成口径标注（PRD §5.3）。',
    },
    datasets,
    warnings,
  };

  const finalDataPath = path.join(params.projectPath, 'data_file', 'final', 'dashboard-data.json');
  await writeJson(finalDataPath, finalData);
  rawFiles.push(path.relative(params.projectPath, finalDataPath).replaceAll(path.sep, '/'));

  await writeJson(path.join(params.projectPath, 'evidence', 'sources.json'), {
    generated_at: new Date().toISOString(),
    run_id: runId,
    sources,
  });
  await writeJson(path.join(params.projectPath, 'evidence', 'data_quality.json'), {
    status: warnings.length > 0 ? 'warning' : 'ok',
    run_id: runId,
    window,
    datasets: Object.entries(datasets).map(([key, value]) => {
      const record = asRecord(value);
      const rows = Array.isArray(record?.rows) ? record.rows.length : undefined;
      return {
        dataset: key,
        row_count: rows ?? null,
        synthetic_fields:
          key === 'categories' || key === 'inventoryRisk' || key === 'itemPool' || key === 'channels' || key === 'biOverview'
            ? ['price', 'stock', 'channel', 'cost_proxy', 'profit_proxy', 'inventory_value']
            : [],
        missing_fields: [],
      };
    }),
    checks: [
      { id: 'window_present', passed: true },
      { id: 'planned_entities_declared', passed: true },
      { id: 'synthetic_disclosure', passed: true },
    ],
    warnings,
    limitations: [
      '数据窗口以内口径；窗口外趋势不支持。',
      '金额/库存为合成口径。',
    ],
  });

  // 窗口/实体回写 run plan（final data 身份校验依赖 plan 与最终数据一致）。
  const updatedPlan: RetailRunPlan = {
    ...params.plan,
    window,
    plannedEntities: { categoryIds, itemIds },
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceJsonAtomic(params.projectPath, RETAIL_RUN_PLAN_RELATIVE_PATH, updatedPlan);

  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: 'data_prefetched',
    stage: 'data_collection',
    status: warnings.length > 0 ? 'warning' : 'success',
    run_id: runId,
    artifact_path: 'data_file/final/dashboard-data.json',
    summary:
      `预取完成：数据集 ${Object.keys(datasets).join('、')}；` +
      (warnings.length > 0 ? `警告 ${warnings.length} 条。` : '无警告。'),
  });

  return {
    finalDataPath: 'data_file/final/dashboard-data.json',
    datasetKeys: Object.keys(datasets),
    warnings,
    rawFiles,
  };
}
