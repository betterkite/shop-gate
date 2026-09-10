import type { RetailCapabilityId } from './capabilities';

export interface RetailVisualizationTemplate {
  templateId: string;
  variantId: string;
  capabilityId: RetailCapabilityId;
  name: string;
  scenario: string;
  variantName: string;
  variantScenario: string;
  layout: string;
  density: string;
  requiredComponents: readonly string[];
  optionalComponents: readonly string[];
  panels: readonly string[];
  firstViewport: readonly string[];
  variantGuidance: readonly string[];
  dataRequirements: readonly string[];
  dataSignals: readonly string[];
  painPoints: readonly string[];
  finalDataContract: readonly string[];
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
    scenario: '整体或分类目的 pv→fav→cart→buy 漏斗与分日趋势',
    variantName: '标准漏斗',
    variantScenario: '漏斗总览 + 分日趋势 + 分类目对比',
    layout: 'hero + 双 chart-zone',
    density: 'dense',
    requiredComponents: [
      '漏斗事件总览',
      '分日转化趋势',
      '分类目对比表',
      '数据质量说明',
    ],
    optionalComponents: ['类目漏斗明细'],
    panels: ['hero-panel', 'chart-zone:funnel', 'chart-zone:daily', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:funnel'],
    variantGuidance: [
      '漏斗每阶段标注事件数口径。',
      '首屏必须出现漏斗图与转化率表。',
    ],
    dataRequirements: ['datasets.funnel', 'datasets.funnelDaily'],
    dataSignals: ['stage_events', 'conversion_from_previous', 'daily_series'],
    painPoints: ['漏斗口径（事件数）容易被误读为用户数'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.funnel', 'datasets.funnelDaily'],
  },
  {
    templateId: 'catalog-structure',
    variantId: 'base',
    capabilityId: 'catalog_structure',
    name: '类目与商品结构看板',
    scenario: '类目 GMV/转化排名、集中度与商品动销',
    variantName: '标准结构',
    variantScenario: '类目排名 + 集中度 + 商品明细',
    layout: 'hero + chart-zone + dense-table',
    density: 'dense',
    requiredComponents: [
      '类目GMV排名',
      '集中度口径',
      '类目指标矩阵',
      '高流量低转化诊断',
      '数据质量说明',
    ],
    optionalComponents: ['商品动销明细'],
    panels: ['hero-panel', 'chart-zone:categories', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:categories'],
    variantGuidance: [
      '集中度必须标注 top-5 GMV 占比口径。',
      '类目名保留 synthetic_name 标注。',
    ],
    dataRequirements: ['datasets.categories'],
    dataSignals: ['gmv', 'buy_conversion', 'avg_price', 'concentration', 'traffic_conversion_gap'],
    painPoints: ['合成金额不能被表述为真实交易数据'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.categories'],
  },
  {
    templateId: 'price-inventory',
    variantId: 'base',
    capabilityId: 'price_inventory',
    name: '价格与库存看板（合成口径）',
    scenario: '价格带分布、库销比排行与滞销清单',
    variantName: '标准价库',
    variantScenario: '价格带 + 库销比排行',
    layout: 'hero + 双 chart-zone + dense-table',
    density: 'dense',
    requiredComponents: [
      '价格带分布',
      '库销比排行',
      '滞销清单说明',
      '合成口径标注',
    ],
    optionalComponents: ['零销量商品单独标注'],
    panels: ['hero-panel', 'chart-zone:bands', 'chart-zone:inventory', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'chart-zone:bands'],
    variantGuidance: [
      '价格/库存全部为合成口径，徽标不可省略。',
      '库销比口径：库存 / 日均销量，零销量用地板值。',
    ],
    dataRequirements: ['datasets.inventoryRisk'],
    dataSignals: ['price', 'stock', 'sell_through_ratio', 'sold', 'views'],
    painPoints: ['库销比排行容易被误读为操作指令'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.inventoryRisk'],
  },
  {
    templateId: 'daily-brief',
    variantId: 'base',
    capabilityId: 'daily_brief',
    name: '经营日报看板',
    scenario: '单日经营摘要、环比与类目异动',
    variantName: '标准日报',
    variantScenario: '摘要卡 + 环比 + 异动榜',
    layout: 'hero + insight-strip + chart-zone',
    density: 'dense',
    requiredComponents: [
      '当日总量摘要',
      '环比表',
      '类目异动榜',
      '数据质量说明',
    ],
    optionalComponents: ['观察池动态'],
    panels: ['hero-panel', 'insight-strip', 'chart-zone:movers', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'insight-strip'],
    variantGuidance: [
      '首日无环比必须明示。',
      '日报结论用“当日观察”措辞。',
    ],
    dataRequirements: ['datasets.summary', 'datasets.categories'],
    dataSignals: ['totals', 'day_over_day', 'avg_price', 'buy_conversion', 'category_movement'],
    painPoints: ['9 天窗口不支持长期趋势推断'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.summary', 'datasets.categories'],
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

export function serializeRetailVisualizationTemplate(
  capabilityId: string | null | undefined,
  params: {
    instruction?: string;
    entityCount?: number;
    requestedVariantId?: string | null;
    dataSignals?: string[];
  } = {},
): RetailVisualizationTemplate & { matchReasons: string[] } {
  const template = getRetailVisualizationTemplate(capabilityId);
  const matchReasons: string[] = [
    `能力 ${template.capabilityId} 的默认模板（v1 单变体）。`,
  ];
  if (params.entityCount !== undefined) {
    matchReasons.push(
      params.entityCount > 0
        ? `检测到 ${params.entityCount} 个显式实体引用。`
        : '未检测到显式实体引用，按全库口径展示。',
    );
  }
  if (params.instruction && /环比|日报|异动/.test(params.instruction)) {
    matchReasons.push('指令包含环比/异动词，优先展示当日摘要与异动榜。');
  }
  void params.requestedVariantId;
  const dataSignals = params.dataSignals?.length
    ? params.dataSignals
    : [...template.dataSignals];
  return { ...template, dataSignals, matchReasons };
}
