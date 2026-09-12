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
    scenario: '经营 KPI、日趋势、渠道/类目拆解、库销比排行与运营行动',
    variantName: '标准价库',
    variantScenario: '总览 + 趋势 + 异常 + 拆解 + 行动',
    layout: 'hero + 双 chart-zone + dense-table',
    density: 'dense',
    requiredComponents: [
      '经营 KPI 总览',
      '分日经营趋势',
      '价格带分布',
      '渠道与类目拆解',
      '库销比排行',
      '异常诊断',
      '行动建议',
      '合成口径标注',
    ],
    optionalComponents: ['零销量商品单独标注'],
    panels: ['hero-panel', 'insight-strip:kpis', 'chart-zone:daily', 'chart-zone:bands', 'chart-zone:breakdown', 'chart-zone:anomalies', 'action-strip', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'insight-strip:kpis', 'chart-zone:daily'],
    variantGuidance: [
      '价格/库存全部为合成口径，徽标不可省略。',
      '库销比口径：库存 / 日均销量，零销量用地板值。',
    ],
    dataRequirements: ['datasets.biOverview', 'datasets.inventoryRisk', 'datasets.channels', 'datasets.itemPool'],
    dataSignals: ['kpis', 'daily', 'channels', 'categories', 'price', 'stock', 'sell_through_ratio', 'sold', 'views', 'buy_conversion', 'actions'],
    painPoints: ['库销比排行容易被误读为操作指令'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.inventoryRisk'],
  },
  {
    templateId: 'analytics-bi',
    variantId: 'p28-expanded',
    capabilityId: 'price_inventory',
    name: '电商经营分析 BI 看板',
    scenario: '总览、用户、渠道、利润、库存、商品阶段和数据边界的扩展经营分析',
    variantName: 'P28 扩展分析',
    variantScenario: '经营总览 + 趋势 + 商品阶段 + 用户留存 + 渠道利润 + 库存异常 + 行动边界',
    layout: 'hero + insight-strip + chart-zone + dense-table',
    density: 'dense',
    requiredComponents: ['经营 KPI 总览', '分日经营趋势', '商品经营阶段', '用户留存 cohort', '渠道与利润拆解', '库存异常', '补货参考', '行动建议', '合成口径与数据缺口说明'],
    optionalComponents: ['用户分群', '价格带对比'],
    panels: ['hero-panel', 'insight-strip:kpis', 'chart-zone:daily', 'chart-zone:lifecycle', 'chart-zone:retention', 'chart-zone:profit', 'chart-zone:inventory', 'chart-zone:replenishment', 'chart-zone:price-experiment', 'action-strip', 'data-quality-footer'],
    firstViewport: ['hero-panel', 'insight-strip:kpis', 'chart-zone:daily'],
    variantGuidance: ['扩展分析接口返回的用户、渠道、成本和库存字段必须保留合成边界。', '商品阶段只解释窗口内购买活跃度，不得表述为真实上下架生命周期。', '价格弹性数据不足时展示缺口，不生成伪造系数。', '价格实验模拟只展示对照组与处理组购买率差异，不得写成真实因果结论或直接调价建议。', '补货参考必须展示供货周期、目标覆盖天数和计算公式，不得写成立即采购指令。'],
    dataRequirements: ['datasets.biOverview', 'datasets.analyticsOverview', 'datasets.analyticsLifecycle', 'datasets.analyticsRetention', 'datasets.analyticsProfit', 'datasets.analyticsInventory', 'datasets.analyticsReplenishment'],
    dataSignals: ['kpis', 'daily', 'lifecycle', 'retention', 'channels', 'profit', 'inventory', 'price_experiment', 'actions', 'limitations'],
    painPoints: ['扩展经营分析数据集为演示数据，不能替代真实财务和供应链结论'],
    finalDataContract: ['window', 'plannedEntities', 'datasets.biOverview', 'datasets.analyticsOverview', 'datasets.analyticsLifecycle', 'datasets.analyticsRetention', 'datasets.analyticsProfit', 'datasets.analyticsInventory', 'datasets.analyticsReplenishment'],
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
  const wantsExpandedAnalytics = capabilityId === 'price_inventory' && (
    params.requestedVariantId === 'p28-expanded' ||
    /经营分析|用户分群|生命周期|商品阶段|毛利|价格弹性|渠道活动/.test(params.instruction ?? '')
  );
  const template = wantsExpandedAnalytics
    ? RETAIL_VISUALIZATION_TEMPLATES.find((candidate) => candidate.templateId === 'analytics-bi') ?? getRetailVisualizationTemplate(capabilityId)
    : getRetailVisualizationTemplate(capabilityId);
  const matchReasons: string[] = [
    wantsExpandedAnalytics
      ? '任务包含 P28 扩展经营分析主题，选择 analytics-bi 模板。'
      : `能力 ${template.capabilityId} 的默认模板。`,
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
  const dataSignals = params.dataSignals?.length
    ? params.dataSignals
    : [...template.dataSignals];
  return { ...template, dataSignals, matchReasons };
}
