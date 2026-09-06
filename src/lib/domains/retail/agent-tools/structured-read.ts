import type {
  PiAgentJsonArtifactConfiguration,
  PiAgentJsonArtifactIdentityResult,
} from '@/lib/agent/tools';

/**
 * 零售实体身份 = `item:<id>` / `cat:<id>`。零售实体 ID 是任意大整数，
 * 不用位形正则识别；身份集合来自 finalData 的 plannedEntities 与
 * datasets 内出现的 item_id/category_id。
 */
function collectEntityIds(value: unknown, kind: 'item' | 'category', sink: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectEntityIds(entry, kind, sink);
    return;
  }
  const record = value as Record<string, unknown>;
  const key = kind === 'item' ? 'item_id' : 'category_id';
  const direct = record[key];
  if ((typeof direct === 'number' && Number.isInteger(direct)) ||
      (typeof direct === 'string' && /^\d+$/.test(direct))) {
    sink.add(`${kind}:${direct}`);
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === 'object') collectEntityIds(child, kind, sink);
  }
}

function retailArtifactEntities(value: unknown): Set<string> {
  const entities = new Set<string>();
  collectEntityIds(value, 'item', entities);
  collectEntityIds(value, 'category', entities);
  return entities;
}

function validateEntityIdentity(
  root: unknown,
  requestedIdentity: string,
): PiAgentJsonArtifactIdentityResult {
  const availableIdentities = [...retailArtifactEntities(root)].sort();
  return {
    matches: availableIdentities.includes(requestedIdentity),
    availableIdentities,
  };
}

export const RETAIL_JSON_ARTIFACT_CONFIGURATION: PiAgentJsonArtifactConfiguration = {
  paths: {
    final_dashboard: 'data_file/final/dashboard-data.json',
    sources_evidence: 'evidence/sources.json',
    data_quality_evidence: 'evidence/data_quality.json',
    query_rewrite: '.data-agent/retail-query-rewrite.json',
    run_plan: '.data-agent/retail-run-plan.json',
    task: '.data-agent/task.json',
    plan: '.data-agent/plan.json',
    validation_report: '.data-agent/validation.json',
  },
  preferredObjectKeys: [
    'window',
    'stat_date',
    'plannedEntities',
    'funnel',
    'stages',
    'conversion_from_previous',
    'buy_conversion',
    'gmv',
    'avg_price',
    'pv',
    'cart',
    'buy',
    'buyers',
    'price',
    'stock',
    'sell_through_ratio',
    'synthetic',
    'synthetic_fields',
    'day_over_day',
    'totals',
    'rows',
    'data_quality',
  ],
  resolveAlias(requestedPath) {
    const normalized = requestedPath.trim().replace(/^\/+/u, '').replace(/^\.\//u, '');
    if (
      /^(?:public\/data\/|data\/)?dashboard(?:-data)?\.json$/iu.test(normalized)
    ) {
      return { artifactId: 'final_dashboard' };
    }
    return null;
  },
  validateAliasIdentity: validateEntityIdentity,
  toolDescription:
    'Batch-query all required RFC 6901 JSON Pointers from one Retail workspace JSON artifact in a single call (maximum 16). Prefer artifact="final_dashboard" and request window, funnel, categories, item series, inventory rows, daily summary, and data quality together.',
  artifactDescription:
    'Authoritative Retail artifact handle. Prefer final_dashboard instead of guessing a public/data path.',
  pathDescription:
    'Workspace-relative JSON file. Omit when artifact is supplied. Retail dashboard data is data_file/final/dashboard-data.json.',
  pointersDescription:
    'All needed Retail paths in one array, for example ["/window","/plannedEntities","/datasets/funnel","/datasets/categories","/datasets/inventoryRisk","/datasets/summary","/data_quality"].',
};
