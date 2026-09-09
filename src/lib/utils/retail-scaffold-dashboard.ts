import fs from 'fs/promises';
import path from 'path';
import {
  retailBaseDashboardPageTemplate,
  retailBaseDashboardCssTemplate,
  retailFunnelPageTemplate,
  retailCatalogPageTemplate,
  retailPriceInventoryPageTemplate,
  retailDailyBriefPageTemplate,
} from './retail-scaffold-templates';

/** 零售能力 templateId/capabilityId → 页面模板（与 dashboard-spec renderer 一致）。 */
const RETAIL_TEMPLATE_BY_ID: Record<string, () => string> = {
  'funnel-analysis': retailFunnelPageTemplate,
  traffic_funnel: retailFunnelPageTemplate,
  'catalog-structure': retailCatalogPageTemplate,
  catalog_structure: retailCatalogPageTemplate,
  'price-inventory': retailPriceInventoryPageTemplate,
  price_inventory: retailPriceInventoryPageTemplate,
  'daily-brief': retailDailyBriefPageTemplate,
  daily_brief: retailDailyBriefPageTemplate,
};

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 零售标准生成路径：按 run plan 的可视化 templateId（或 capabilityId）把页面写成
 * 对应能力看板模板，而不是落下仅含"数据集覆盖"的 base 骨架。
 *
 * 调用方负责先 scaffoldBasicNextApp。旧金融模板入口已移除。
 * 识别不到零售 templateId 便提前 return，只保留 base 页；此函数让标准看板直接产出
 * 对应能力的柱状图/趋势图/指标矩阵。
 */
export async function writeRetailDashboardTemplate(projectPath: string): Promise<void> {
  const runPlan = await readJsonRecord(
    path.join(projectPath, '.data-agent', 'retail-run-plan.json'),
  );
  const visualization = readRecord(runPlan?.visualization);
  const templateId =
    typeof visualization?.templateId === 'string'
      ? visualization.templateId
      : typeof visualization?.template_id === 'string'
        ? visualization.template_id
        : typeof runPlan?.capabilityId === 'string'
          ? runPlan.capabilityId
          : null;
  const effective = (templateId ?? '').toLowerCase();
  const pageTemplate =
    RETAIL_TEMPLATE_BY_ID[effective] ?? retailBaseDashboardPageTemplate;
  await fs.writeFile(
    path.join(projectPath, 'app', 'page.tsx'),
    pageTemplate(),
    'utf8',
  );
  await fs.writeFile(
    path.join(projectPath, 'app', 'globals.css'),
    retailBaseDashboardCssTemplate(),
    'utf8',
  );
}
