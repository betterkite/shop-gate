import fs from 'node:fs/promises';
import path from 'node:path';
import type { RetailRunPlan } from './workspace';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function contextUrl(datasetId: string, dimension?: string, value?: string): string {
  const query = new URLSearchParams({
    view: dimension && value ? 'drilldown' : 'overview',
    dataset_id: datasetId,
  });
  if (dimension && value) {
    query.set('dimension', dimension);
    query.set('value', value);
  }
  return `/analytics-workbench?${query.toString()}`;
}

export async function appendRetailAnswerContext(params: {
  summary: string;
  workspaceRoot: string;
  runPlan: RetailRunPlan | null;
}): Promise<string> {
  const summary = params.summary.trim();
  if (!summary || params.runPlan?.queryRewrite?.outputIntent !== 'answer') return summary;

  try {
    const finalData = asRecord(JSON.parse(
      await fs.readFile(path.join(params.workspaceRoot, 'data_file/final/dashboard-data.json'), 'utf8'),
    ) as unknown);
    const datasetId = stringValue(finalData?.datasetId ?? finalData?.dataset_id ?? params.runPlan.datasetId);
    if (!finalData || !datasetId) return summary;

    const datasets = asRecord(finalData.datasets);
    const funnel = asRecord(datasets?.funnel);
    const savedScope = params.runPlan.context?.scope;
    const funnelFilter = asRecord(funnel?.filter);
    const dimension = savedScope?.dimension ?? stringValue(funnelFilter?.dimension) ?? undefined;
    const value = savedScope?.value ?? stringValue(funnelFilter?.value) ?? undefined;
    const link = stringValue(funnel?.context_url) ?? contextUrl(datasetId, dimension, value);
    const window = asRecord(finalData.window);
    const windowText = window?.start && window?.end
      ? `；时间范围 ${String(window.start)} ~ ${String(window.end)}`
      : '';
    const scopeText = dimension && value ? `；当前查看 ${dimension}=${value}` : '；当前查看全店数据';
    const contextBlock = `\n\n数据范围：数据集 ${datasetId}${scopeText}${windowText}。\n打开这份明细结果：[查看当前分析](${link})`;
    return summary.includes(link) ? summary : `${summary}${contextBlock}`;
  } catch {
    return summary;
  }
}
