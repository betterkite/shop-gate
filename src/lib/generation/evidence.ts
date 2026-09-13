import fs from 'fs/promises';
import path from 'path';
import { appendRetailWorkspaceEvent, ensureRetailWorkspace } from '@/lib/domains/retail/workspace';

type JsonRecord = Record<string, unknown>;
type EvidenceStatus = 'ok' | 'warning' | 'error';

interface DatasetEvidence {
  id: string;
  name: string;
  source: string;
  endpoint: string;
  artifact_path: string;
  row_count: number;
  fetched_at: string | null;
  as_of: string | null;
  missing_fields: string[];
  warnings: string[];
  status: EvidenceStatus;
  critical: boolean;
  fetch?: {
    cache_status?: string;
    cache_ttl_seconds?: number;
    cached_at?: string;
    expires_at?: string;
  };
}

export interface BaselineEvidenceResult {
  created: boolean;
  status?: EvidenceStatus;
  sourceCount?: number;
  reason?: string;
}

const FINAL_DATA_RELATIVE_PATH = 'data_file/final/dashboard-data.json';
const SOURCES_RELATIVE_PATH = 'evidence/sources.json';
const DATA_QUALITY_RELATIVE_PATH = 'evidence/data_quality.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

async function readJsonRecord(filePath: string): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value !== 'string' || value.trim().length > 0;
}

function buildFetchEvidence(record: JsonRecord | null): DatasetEvidence['fetch'] | undefined {
  const fetchRecord = asRecord(record?.fetch);
  if (!fetchRecord) {
    return undefined;
  }

  const cacheStatus = pickString(fetchRecord.cache_status);
  const cacheTtlRaw = fetchRecord.cache_ttl_seconds;
  const cacheTtlSeconds = typeof cacheTtlRaw === 'number' && Number.isFinite(cacheTtlRaw) ? cacheTtlRaw : undefined;
  const cachedAt = pickString(fetchRecord.cached_at);
  const expiresAt = pickString(fetchRecord.expires_at);

  if (!cacheStatus && cacheTtlSeconds === undefined && !cachedAt && !expiresAt) {
    return undefined;
  }

  return {
    ...(cacheStatus ? { cache_status: cacheStatus } : {}),
    ...(cacheTtlSeconds !== undefined ? { cache_ttl_seconds: cacheTtlSeconds } : {}),
    ...(cachedAt ? { cached_at: cachedAt } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

function missingRequiredGroups(
  record: JsonRecord | null,
  groups: Array<{ label: string; keys: string[] }>
): string[] {
  return groups
    .filter((group) => !record || !group.keys.some((key) => isPresent(record[key])))
    .map((group) => group.label);
}

function buildDataset(params: {
  id: string;
  name: string;
  record: JsonRecord | null;
  rowCount: number;
  source: string;
  endpoint: string;
  critical: boolean;
  generatedAt: string | null;
  missingFields: string[];
  warnings?: string[];
}): DatasetEvidence {
  const fetchedAt = pickString(params.record?.fetched_at, params.generatedAt);
  const asOf = pickString(
    params.record?.as_of,
    asRecord(params.record?.window)?.end,
    fetchedAt,
  );
  const warnings = [...(params.warnings ?? [])];

  if (params.rowCount <= 0) {
    warnings.push('未检测到可用样本。');
  }
  if (params.missingFields.length > 0) {
    warnings.push(`缺失字段：${params.missingFields.join('、')}。`);
  }

  const status: EvidenceStatus =
    params.rowCount <= 0 && params.critical ? 'error' : warnings.length > 0 ? 'warning' : 'ok';

  return {
    id: params.id,
    name: params.name,
    source: params.source,
    endpoint: params.endpoint,
    artifact_path: FINAL_DATA_RELATIVE_PATH,
    row_count: params.rowCount,
    fetched_at: fetchedAt,
    as_of: asOf,
    missing_fields: params.missingFields,
    warnings,
    status,
    critical: params.critical,
    fetch: buildFetchEvidence(params.record),
  };
}

function isUsableSourcesEvidence(value: JsonRecord | null): value is JsonRecord & { sources: unknown[] } {
  const sources = value?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return false;
  }
  return /source|endpoint|fetched_at|as_of|artifact_path/i.test(JSON.stringify(value));
}

function isUsableQualityEvidence(value: JsonRecord | null): value is JsonRecord & { status: EvidenceStatus } {
  const status = value?.status;
  if (!['ok', 'warning', 'error'].includes(typeof status === 'string' ? status : '')) {
    return false;
  }
  return /datasets|checks|missing_fields|warnings|limitations|row_count|fetched_at/i.test(JSON.stringify(value));
}

const RETAIL_DATASET_LABELS: Record<string, string> = {
  meta: '数据集概况',
  funnel: '行为转化汇总',
  funnelDaily: '行为转化日趋势',
  categories: '类目经营汇总',
  inventoryRisk: '库存风险明细',
  channels: '渠道经营汇总',
  itemPool: '商品明细池',
  biOverview: '经营分析总览',
  analyticsOverview: '经营分析指标',
  analyticsLifecycle: '商品经营阶段',
  analyticsProfit: '利润分析',
  analyticsInventory: '库存分析',
  analyticsChannels: '渠道分析',
  analyticsElasticity: '价格观察',
  summary: '经营日报摘要',
};

function datasetRowCount(record: JsonRecord | null): number {
  if (!record) return 0;
  for (const key of ['rows', 'items', 'metrics', 'daily', 'stages', 'categories', 'channels', 'price_bands']) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return Object.keys(record).length > 0 ? 1 : 0;
}

function datasetEndpoint(id: string): string {
  return `GET /api/v1/commerce/analytics/${id}`;
}

function criticalRetailDatasets(runPlan: JsonRecord | null): Set<string> {
  const capabilityId = pickString(runPlan?.capabilityId, runPlan?.requestedCapabilityId);
  const templateId = pickString(asRecord(runPlan?.visualization)?.templateId);
  if (templateId === 'analytics-bi' || capabilityId === 'analytics_bi') {
    return new Set(['analyticsOverview']);
  }
  if (templateId === 'funnel-analysis' || capabilityId === 'traffic_funnel') {
    return new Set(['funnel']);
  }
  if (templateId === 'price-inventory' || capabilityId === 'price_inventory') {
    return new Set(['inventoryRisk']);
  }
  if (templateId === 'catalog-structure' || capabilityId === 'catalog_structure') {
    return new Set(['categories']);
  }
  if (templateId === 'daily-brief' || capabilityId === 'daily_brief') {
    return new Set(['summary']);
  }
  return new Set(['meta']);
}

function buildDatasets(data: JsonRecord, runPlan: JsonRecord | null): DatasetEvidence[] {
  const sourceDatasets = asRecord(data.datasets);
  if (!sourceDatasets) return [];

  const generatedAt = pickString(data.generatedAt, data.generated_at, data.fetched_at);
  const rootSource = pickString(data.source, 'shopgate-commerce-data') ?? 'shopgate-commerce-data';
  const critical = criticalRetailDatasets(runPlan);

  return Object.entries(sourceDatasets).map(([id, value]) => {
    const record = asRecord(value);
    const rowCount = datasetRowCount(record);
    const missingFields = missingRequiredGroups(record, [
      { label: 'window', keys: ['window', 'start', 'end'] },
    ]);
    const warnings = Array.isArray(record?.limitations)
      ? record.limitations.filter((item): item is string => typeof item === 'string')
      : [];

    return buildDataset({
      id,
      name: RETAIL_DATASET_LABELS[id] ?? id,
      record,
      rowCount,
      source: pickString(record?.source, rootSource) ?? rootSource,
      endpoint: datasetEndpoint(id),
      critical: critical.has(id),
      generatedAt,
      missingFields,
      warnings,
    });
  });
}

function buildStatus(datasets: DatasetEvidence[]): EvidenceStatus {
  if (datasets.some((dataset) => dataset.status === 'error')) {
    return 'error';
  }
  if (datasets.some((dataset) => dataset.status === 'warning')) {
    return 'warning';
  }
  return 'ok';
}

export async function ensureBaselineEvidenceFiles(
  projectPath: string,
  options: { force?: boolean } = {}
): Promise<BaselineEvidenceResult> {
  await ensureRetailWorkspace(projectPath);

  const sourcesPath = path.join(projectPath, SOURCES_RELATIVE_PATH);
  const qualityPath = path.join(projectPath, DATA_QUALITY_RELATIVE_PATH);
  const existingSources = await readJsonRecord(sourcesPath);
  const existingQuality = await readJsonRecord(qualityPath);

  if (!options.force && isUsableSourcesEvidence(existingSources) && isUsableQualityEvidence(existingQuality)) {
    const sourceCount = Array.isArray(existingSources.sources) ? existingSources.sources.length : undefined;
    const status = typeof existingQuality.status === 'string' ? (existingQuality.status as EvidenceStatus) : undefined;
    return { created: false, status, sourceCount };
  }

  const finalData = await readJsonRecord(path.join(projectPath, FINAL_DATA_RELATIVE_PATH));
  if (!finalData) {
    return {
      created: false,
      reason: `未找到可用于生成 evidence 的 ${FINAL_DATA_RELATIVE_PATH}。`,
    };
  }

  const runPlan = await readJsonRecord(path.join(projectPath, '.data-agent', 'retail-run-plan.json'));
  const now = new Date().toISOString();
  const runId = pickString(runPlan?.runId, runPlan?.run_id, finalData.runId, finalData.generatedAt, now) ?? now;
  const datasetId = pickString(finalData.dataset_id, runPlan?.datasetId, '未指定数据集') ?? '未指定数据集';
  const datasetName = pickString(finalData.dataset_name, '零售经营数据集') ?? '零售经营数据集';
  const datasets = buildDatasets(finalData, runPlan);
  const status = buildStatus(datasets);
  const warnings = datasets.flatMap((dataset) =>
    dataset.warnings.map((warning) => `${dataset.name}：${warning}`)
  );
  const limitations = [
    '商品价格、库存、品牌和店铺等字段如果标记为合成口径，只用于经营分析演示，不代表真实交易事实。',
    '本 evidence 由 Shop Gate 平台根据当前数据集的最终数据文件自动生成，模型可在后续分析中补充更细的字段口径说明。',
  ];

  const sourcesEvidence = {
    schemaVersion: 1,
    runId,
    generated_by: 'shopgate-platform',
    created_at: now,
    dataset_id: datasetId,
    dataset_name: datasetName,
    sources: datasets.map((dataset) => ({
      id: dataset.id,
      dataset: dataset.name,
      source: dataset.source,
      endpoint: dataset.endpoint,
      artifact_path: dataset.artifact_path,
      row_count: dataset.row_count,
      fetched_at: dataset.fetched_at,
      as_of: dataset.as_of,
      status: dataset.status,
      fetch: dataset.fetch,
    })),
  };

  const dataQualityEvidence = {
    schemaVersion: 1,
    runId,
    generated_by: 'shopgate-platform',
    created_at: now,
    status,
    dataset_id: datasetId,
    dataset_name: datasetName,
    datasets: datasets.map(({ critical, ...dataset }) => ({
      ...dataset,
      required: critical,
    })),
    checks: datasets.map((dataset) => ({
      id: `${dataset.id}_quality`,
      dataset: dataset.id,
      status: dataset.status,
      row_count: dataset.row_count,
      missing_fields: dataset.missing_fields,
      summary:
        dataset.status === 'ok'
          ? `${dataset.name}数据形态可用。`
          : `${dataset.name}存在质量提示，需要在页面或结论中说明。`,
    })),
    warnings,
    limitations,
  };

  await fs.mkdir(path.dirname(sourcesPath), { recursive: true });
  await Promise.all([
    fs.writeFile(sourcesPath, `${JSON.stringify(sourcesEvidence, null, 2)}\n`, 'utf8'),
    fs.writeFile(qualityPath, `${JSON.stringify(dataQualityEvidence, null, 2)}\n`, 'utf8'),
  ]);

  await appendRetailWorkspaceEvent(projectPath, {
    event_type: 'data_quality_checked',
    stage: 'data_quality',
    status: status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'success',
    run_id: runId,
    artifact_path: DATA_QUALITY_RELATIVE_PATH,
    summary: `已自动生成数据质量证据，状态：${status}，来源数量：${datasets.length}。`,
    created_at: now,
  });

  return {
    created: true,
    status,
    sourceCount: datasets.length,
  };
}
