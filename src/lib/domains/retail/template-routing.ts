import type { RetailQueryRewriteResult } from './query-rewrite';
import type {
  RetailTemplateOutputMode,
  RetailVisualizationTemplate,
} from './visualization-templates';

export type RetailRouteStatus =
  | 'answer'
  | 'dashboard'
  | 'needs_clarification'
  | 'template_not_supported';

export type RetailRequestOutputMode = 'act' | 'chat';

export interface RetailTemplateMatchResult {
  routeStatus: RetailRouteStatus;
  requestedMetrics: string[];
  requestedDimensions: string[];
  missingMetrics: string[];
  missingDimensions: string[];
  reason: string;
}

const EXPLICIT_ANSWER_PATTERN = /只(?:做|进行)?问答|只回答|不要(?:生成)?(?:经营)?看板|不(?:需要|要)(?:生成)?(?:看板|图表|可视化)/i;
const EXPLICIT_DASHBOARD_PATTERN = /生成(?:经营)?看板|看板|可视化|图表|BI|漏斗图/i;
const COMPLEX_ANALYSIS_PATTERN = /趋势|分日|按日|环比|异动|结构|分布|拆解|漏斗|对比|比较|集中度|日报|诊断|下钻|矩阵|留存|生命周期|商品阶段|用户分群/i;
const SIMPLE_QUESTION_PATTERN = /^(?:请问|请告诉我|帮我看下|想知道)?[^。！？!?]{0,80}(?:是什么|有哪些|多少|哪(?:些|个)|如何|怎么样|排行|排名|top\s*\d+)[？?。！!]?$/i;

const METRIC_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['page_views', /页面浏览|浏览量|浏览次数|曝光|PV\b/i],
  ['unique_visitors', /独立访客|访客数|UV\b/i],
  ['favorites', /收藏|关注行为/i],
  ['carts', /加购|购物车|cart/i],
  ['purchases', /购买|成交量|销量|订单数|下单/i],
  ['buy_conversion', /购买转化|成交转化|转化率/i],
  ['gmv', /GMV|成交总额|销售额|成交金额/i],
  ['avg_price', /客单价|平均每次购买金额|平均价格/i],
  ['price', /价格|价格带|售价/i],
  ['stock', /库存|库存量|可售天数/i],
  ['sell_through_ratio', /库销比|库存相对销量|库存周转/i],
  ['price_elasticity', /价格弹性|需求弹性/i],
  ['lifecycle', /生命周期|商品阶段|经营阶段/i],
  ['retention', /留存|复购|cohort/i],
  ['profit', /利润|毛利|贡献利润/i],
  ['replenishment', /补货|安全库存|供货周期/i],
  ['price_experiment', /价格实验|对照组|处理组|价格测试/i],
  ['daily_series', /趋势|分日|按日|每天|每日|环比|日报/i],
  ['concentration', /集中度|top.?\d+.*占比/i],
  ['category_movement', /类目异动|异动类目/i],
];

const DIMENSION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['date', /日期|分日|按日|每天|每日|趋势|环比|日报|最近\s*\d+\s*(?:天|日|周|月)/i],
  ['category', /类目|品类/i],
  ['item', /商品|单品|SKU|sku/i],
  ['channel', /渠道|来源渠道/i],
  ['user', /用户|买家|会员|人群|分群/i],
  ['campaign', /活动|促销|营销活动/i],
  ['price_band', /价格带|价格区间/i],
];

function hasExplicitAnswerOnly(query: string): boolean {
  return EXPLICIT_ANSWER_PATTERN.test(query);
}

export function inferRetailOutputIntent(params: {
  query: string;
  rewriteIntent?: RetailTemplateOutputMode;
  requestedOutputMode?: RetailRequestOutputMode | null;
}): RetailTemplateOutputMode {
  const query = params.query.trim();
  // 用户文字中的明确“不出图”优先于按钮模式，防止把冲突输入静默当成看板任务。
  if (hasExplicitAnswerOnly(query)) return 'answer';
  if (params.requestedOutputMode === 'chat') return 'answer';
  if (params.requestedOutputMode === 'act') return 'dashboard';
  if (EXPLICIT_DASHBOARD_PATTERN.test(query)) return 'dashboard';
  if (params.rewriteIntent === 'answer') return 'answer';
  if (COMPLEX_ANALYSIS_PATTERN.test(query)) return 'dashboard';
  if (SIMPLE_QUESTION_PATTERN.test(query)) return 'answer';
  // 对未能判定的自然语言保留 Query Rewrite 的结论；历史默认仍是看板。
  return params.rewriteIntent ?? 'dashboard';
}

export function extractRetailTemplateRequirements(query: string): {
  metrics: string[];
  dimensions: string[];
} {
  return {
    metrics: METRIC_PATTERNS
      .filter(([, pattern]) => pattern.test(query))
      .map(([metric]) => metric),
    dimensions: DIMENSION_PATTERNS
      .filter(([, pattern]) => pattern.test(query))
      .map(([dimension]) => dimension),
  };
}

export function matchRetailTemplateCoverage(params: {
  query: string;
  outputIntent: RetailTemplateOutputMode;
  template: RetailVisualizationTemplate;
  clarificationRequired?: boolean;
}): RetailTemplateMatchResult {
  const requirements = extractRetailTemplateRequirements(params.query);
  if (params.clarificationRequired) {
    return {
      routeStatus: 'needs_clarification',
      requestedMetrics: requirements.metrics,
      requestedDimensions: requirements.dimensions,
      missingMetrics: [],
      missingDimensions: [],
      reason: '问题仍缺少必要的分析对象或约束，先澄清后再匹配模板。',
    };
  }
  if (params.outputIntent === 'answer') {
    return {
      routeStatus: 'answer',
      requestedMetrics: requirements.metrics,
      requestedDimensions: requirements.dimensions,
      missingMetrics: [],
      missingDimensions: [],
      reason: '当前请求适合先返回数据分析回答，不需要生成看板。',
    };
  }

  const supportedMetrics = new Set(params.template.coverage.metrics);
  const supportedDimensions = new Set(params.template.coverage.dimensions);
  const missingMetrics = requirements.metrics.filter((metric) => !supportedMetrics.has(metric));
  const missingDimensions = requirements.dimensions.filter((dimension) => !supportedDimensions.has(dimension));
  const supportedOutput = params.template.coverage.outputModes.includes(params.outputIntent);
  if (missingMetrics.length > 0 || missingDimensions.length > 0 || !supportedOutput) {
    const missing = [
      ...missingMetrics.map((metric) => `指标 ${metric}`),
      ...missingDimensions.map((dimension) => `维度 ${dimension}`),
      ...(!supportedOutput ? [`输出形式 ${params.outputIntent}`] : []),
    ];
    return {
      routeStatus: 'template_not_supported',
      requestedMetrics: requirements.metrics,
      requestedDimensions: requirements.dimensions,
      missingMetrics,
      missingDimensions,
      reason: `当前模板“${params.template.name}”未声明覆盖：${missing.join('、')}。不会生成不相关的通用看板。`,
    };
  }

  return {
    routeStatus: 'dashboard',
    requestedMetrics: requirements.metrics,
    requestedDimensions: requirements.dimensions,
    missingMetrics: [],
    missingDimensions: [],
    reason: `问题需求与“${params.template.name}”的指标和维度覆盖范围匹配。`,
  };
}

export function applyRetailOutputIntent(
  rewrite: RetailQueryRewriteResult,
  outputIntent: RetailTemplateOutputMode,
): RetailQueryRewriteResult {
  if (rewrite.outputIntent === outputIntent) return rewrite;
  return {
    ...rewrite,
    outputIntent,
    rewrittenQuery: rewrite.rewrittenQuery.replace(
      /输出方式：[^；。]+/u,
      `输出方式：${outputIntent === 'dashboard' ? '生成可验证看板' : '只做分析问答'}`,
    ),
    execution: {
      ...rewrite.execution,
      llm: {
        ...rewrite.execution.llm,
        guardedFields: Array.from(new Set([...rewrite.execution.llm.guardedFields, 'outputIntent'])),
      },
    },
  };
}

