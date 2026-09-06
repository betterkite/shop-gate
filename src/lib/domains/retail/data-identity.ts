type JsonRecord = Record<string, unknown>;

/**
 * 零售 finalData 身份合同（与 data-prefetch 的零售产出对齐）：
 *
 * finalData = {
 *   runId, generatedAt,
 *   window: { start, end },
 *   plannedEntities: { categoryIds: number[], itemIds: number[] },  // 空数组 = 全库口径
 *   datasets: { meta?, funnel?, funnelDaily?, categories?, itemDaily?,
 *               inventoryRisk?, summary? }                         // 每个数据集自带 window
 * }
 *
 * 身份校验只拒绝“声明与计划不一致”的数据集：窗口必须逐日相等，
 * 数据集内出现的 category/item 必须落在计划实体范围内（空计划 = 全库放行）。
 */
const DATASET_KEYS = [
  'meta',
  'funnel',
  'funnelDaily',
  'categories',
  'itemDaily',
  'inventoryRisk',
  'summary',
] as const;

export type RetailDatasetKey = (typeof DATASET_KEYS)[number];

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonEmptyDataset(value: unknown): JsonRecord | null {
  const dataset = record(value);
  return dataset && Object.keys(dataset).length > 0 ? dataset : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoDate(value: unknown): string | null {
  const candidate = string(value);
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function idArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) return null;
    ids.push(item);
  }
  return ids;
}

function nonNegativeIdArray(value: unknown): number[] | null {
  const ids = idArray(value);
  return ids && ids.every((id) => id >= 0) ? ids : null;
}

function windowOf(value: unknown): { start: string; end: string } | null {
  const window = record(value);
  const start = isoDate(window?.start);
  const end = isoDate(window?.end);
  return start && end ? { start, end } : null;
}

function sameWindow(left: { start: string; end: string } | null, right: { start: string; end: string }): boolean {
  return !!left && left.start === right.start && left.end === right.end;
}

function datasetCategoryIds(dataset: JsonRecord): number[] {
  const rows = dataset.rows;
  if (Array.isArray(rows)) {
    const ids = rows
      .map((row) => record(row)?.category_id)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length) return Array.from(new Set(ids));
  }
  const direct = dataset.category_id;
  return typeof direct === 'number' ? [direct] : [];
}

function datasetItemIds(dataset: JsonRecord): number[] {
  const rows = dataset.rows;
  if (Array.isArray(rows)) {
    const ids = rows
      .map((row) => record(row)?.item_id)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length) return Array.from(new Set(ids));
  }
  const direct = dataset.item_id;
  return typeof direct === 'number' ? [direct] : [];
}

export interface RetailDatasetIdentityAssessment {
  ready: boolean;
  reasons: string[];
  runId: string | null;
  window: { start: string; end: string } | null;
  plannedEntities: { categoryIds: number[]; itemIds: number[] };
}

/**
 * 把平台准备的最终数据集绑定到权威规划 run（零氪身份合同的零售版）。
 */
export function assessRetailDatasetIdentity(
  runPlanValue: unknown,
  finalDataValue: unknown,
): RetailDatasetIdentityAssessment {
  const runPlan = record(runPlanValue);
  const finalData = record(finalDataValue);
  const reasons: string[] = [];
  const runId = string(runPlan?.runId);
  const finalRunId = string(finalData?.runId ?? finalData?.run_id);
  const planWindow = windowOf(runPlan?.window);
  const finalWindow = windowOf(finalData?.window);
  const plannedCategories = nonNegativeIdArray(
    record(runPlan?.plannedEntities)?.categoryIds ?? [],
  ) ?? [];
  const plannedItems = nonNegativeIdArray(
    record(runPlan?.plannedEntities)?.itemIds ?? [],
  ) ?? [];

  if (!runPlan) reasons.push('run_plan_invalid');
  if (!finalData) reasons.push('final_data_invalid');
  if (!runId) reasons.push('run_id_missing');
  if (!finalRunId) reasons.push('final_run_id_missing');
  else if (runId && finalRunId !== runId) reasons.push('final_run_id_mismatch');
  if (!planWindow) reasons.push('plan_window_missing');
  if (!finalWindow) reasons.push('final_window_missing');
  else if (planWindow && !sameWindow(finalWindow, planWindow)) {
    reasons.push('final_window_mismatch');
  }

  if (!finalData || !planWindow) {
    return {
      ready: reasons.length === 0,
      reasons: Array.from(new Set(reasons)),
      runId,
      window: finalWindow,
      plannedEntities: { categoryIds: plannedCategories, itemIds: plannedItems },
    };
  }

  const datasets = record(finalData.datasets);
  for (const key of DATASET_KEYS) {
    const dataset = nonEmptyDataset(datasets?.[key] ?? null);
    if (!dataset) continue;
    const datasetWindow = windowOf(dataset.window);
    if (!datasetWindow) {
      reasons.push(`${key}_window_missing`);
      continue;
    }
    if (!sameWindow(datasetWindow, planWindow)) {
      reasons.push(`${key}_window_mismatch`);
    }
    if (plannedCategories.length) {
      const outside = datasetCategoryIds(dataset).filter(
        (id) => !plannedCategories.includes(id),
      );
      if (outside.length) reasons.push(`${key}_categories_outside_plan`);
    }
    if (plannedItems.length) {
      const outside = datasetItemIds(dataset).filter(
        (id) => !plannedItems.includes(id),
      );
      if (outside.length) reasons.push(`${key}_items_outside_plan`);
    }
  }

  return {
    ready: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    runId,
    window: finalWindow,
    plannedEntities: { categoryIds: plannedCategories, itemIds: plannedItems },
  };
}
