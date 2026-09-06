import type { RetailCapabilityId } from './capabilities';

export interface RetailVisualizationTemplate {
  templateId: string;
  variantId: string;
  capabilityId: RetailCapabilityId;
  name: string;
  requiredComponents: readonly string[];
  panels: readonly string[];
  firstViewport: readonly string[];
  dataRequirements: readonly string[];
}

/**
 * v1 单一 variant（base）。面板 id 与 retail-scaffold-templates 的页面
 * 结构一一对应（hero-panel / chart-zone / dense-table / data-quality-footer）。
 */
export const RETAIL_VISUALIZATION_TEMPLATES: readonly RetailVisualizationTemplate[] = [
  {
    templateId: 'funnel-analysis',
    variantId: 'base',
    capabilityId: 'traffic_funnel',
    name: '流量与转化漏斗看板',
    requiredComponents: [
      '漏斗事件总览',
      '分日转化趋势',
      '分类目对比表',
      '数据质量说明',
    ],
    panels: ['hero-panel', 'chart-zone:funnel', 'chart-zone:daily', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:funnel'],
    dataRequirements: ['datasets.funnel', 'datasets.funnelDaily'],
  },
  {
    templateId: 'catalog-structure',
    variantId: 'base',
    capabilityId: 'catalog_structure',
    name: '类目与商品结构看板',
    requiredComponents: [
      '类目GMV排名',
      '集中度口径',
      '类目指标矩阵',
      '数据质量说明',
    ],
    panels: ['hero-panel', 'chart-zone:categories', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:categories'],
    dataRequirements: ['datasets.categories'],
  },
  {
    templateId: 'price-inventory',
    variantId: 'base',
    capabilityId: 'price_inventory',
    name: '价格与库存看板（合成口径）',
    requiredComponents: [
      '价格带分布',
      '库销比排行',
      '滞销清单说明',
      '合成口径标注',
    ],
    panels: ['hero-panel', 'chart-zone:bands', 'chart-zone:inventory', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:bands'],
    dataRequirements: ['datasets.inventoryRisk'],
  },
  {
    templateId: 'daily-brief',
    variantId: 'base',
    capabilityId: 'daily_brief',
    name: '经营日报看板',
    requiredComponents: [
      '当日总量摘要',
      '环比表',
      '类目异动榜',
      '数据质量说明',
    ],
    panels: ['hero-panel', 'insight-strip', 'chart-zone:movers', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'insight-strip'],
    dataRequirements: ['datasets.summary'],
  },
];

export function getRetailVisualizationTemplate(
  capabilityId?: string | null,
): RetailVisualizationTemplate {
  const matched = RETAIL_VISUALIZATION_TEMPLATES.find(
    (template) => !capabilityId || template.capabilityId === capabilityId,
  );
  return matched ?? RETAIL_VISUALIZATION_TEMPLATES[0];
}

export function retailVisualizationRequiredComponents(
  template: RetailVisualizationTemplate,
): string[] {
  return [...template.requiredComponents];
}
