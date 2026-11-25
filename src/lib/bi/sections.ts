export const PRODUCT_CONDITIONS = {
  negative: '已核算贡献小于零', low_margin: '经营贡献利润率低于 10%',
  high_refund: '付款金额中退款超过 10%', incomplete: '还有待核算记录',
  missing_cost: '付款时缺少规格成本', missing_mapping: '付款时没有对应标准规格',
} as const;
export type ProductCondition = keyof typeof PRODUCT_CONDITIONS;
export const BUSINESS_SECTIONS = {
  overview: { title: '经营总览', description: '核对经营指标、自然月目标和需要补齐的数据。' },
  channels: { title: '渠道对比', description: '对比各销售平台的成交、成本、费用和已核算经营贡献。' },
  stores: { title: '店铺分析', description: '查看店铺排名，追踪单店的订单、商品和月度目标。' },
  products: { title: '商品分析', description: '按商品、标准规格或平台商品比较表现，查看关联交易。' },
  costs: { title: '商品成本管理', description: '按生效日期核对成本来源和历史版本，结合经营期间查看成本与利润。' },
  refunds: { title: '退款与售后', description: '核对退款原因、原订单和退货收回的成本，按付款或退款时间查看。' },
  profit: { title: '利润与费用', description: '核对收入、退款、成本和费用，查看本期经营贡献怎样形成、与上期相差多少。' },
  reports: { title: '报表中心', description: '查询七类经营报表，保存常用视图和专题，导出所选范围的全部记录。' },
} as const;
export type BusinessSection = keyof typeof BUSINESS_SECTIONS;
export type RankingSection = Exclude<BusinessSection, 'overview' | 'profit' | 'refunds' | 'costs' | 'reports'>;

const sharedMetrics = {
  net_sales: '净销售额', accounted_contribution: '已核算经营贡献', contribution_margin: '经营贡献利润率',
  order_count: '付款订单数', average_order_value: '付款客单价', product_cost: '商品成本',
  expense_amount: '经营费用', refund_amount: '退款金额', refund_ratio: '退款金额占比',
} as const;
const productMetrics = {
  standard_quantity: '标准销量', selling_channels: '发生付款的平台数', selling_stores: '发生付款的店铺数',
  average_unit_price: '平均单位售价', weighted_unit_cost: '历史加权单位成本', costed_quantity: '有成本依据的标准销量',
} as const;
const profitMetrics = {
  sales_amount: '付款成交金额', refund_amount: '退款金额', net_sales: '净销售额', product_cost: '商品成本净额',
  platform_expense: '平台费用', packaging_expense: '包装费用', logistics_expense: '物流费用', advertising_expense: '广告费用',
  other_expense: '其他费用', expense_amount: '经营费用', known_unallocated_expenses: '已知未分摊费用',
  contribution_profit: '经营贡献利润', accounted_contribution: '已核算经营贡献', contribution_margin: '经营贡献利润率',
} as const;
export const RANK_METRICS = { ...profitMetrics, ...sharedMetrics, ...productMetrics };
export function rankingMetrics(query: Record<string, unknown>, profit = false): RankMetric[] {
  if (profit) return Object.keys(profitMetrics) as RankMetric[];
  const { dimension } = query;
  if (dimension === 'product' || dimension === 'sku' || dimension === 'listing') return Object.keys({ ...sharedMetrics, ...productMetrics }) as RankMetric[];
  const businessMetrics = Object.keys(sharedMetrics) as RankMetric[];
  const hasItem = [query.product_ids, query.sku_ids, query.listing_ids].some((ids) => Array.isArray(ids) && ids.length > 0);
  if (hasItem && (dimension === 'store' || dimension === 'channel')) {
    return [...businessMetrics, 'standard_quantity', 'average_unit_price', 'weighted_unit_cost', 'costed_quantity'];
  }
  return businessMetrics;
}
export function quantityUnit(quality: Record<string, unknown>) {
  const quantities = quality.quantity_by_unit;
  if (!quantities || typeof quantities !== 'object' || Array.isArray(quantities)) return '未记录';
  const names = Object.keys(quantities);
  if (names.length > 1) return '多种单位';
  if (Number(quality.unknown_quantity_lines) > 0) return names.length ? names[0] + '（部分未确认）' : '待确认';
  return names[0] ?? '无付款销量';
}
export type RankMetric = keyof typeof RANK_METRICS;
export function metricUnit(metric: RankMetric) {
  if (metric === 'selling_channels') return '个';
  if (metric === 'selling_stores') return '家';
  if (metric === 'standard_quantity' || metric === 'costed_quantity') return '标准单位';
  if (metric === 'average_unit_price' || metric === 'weighted_unit_cost') return '元/标准单位';
  if (metric === 'order_count') return '笔';
  if (metric === 'contribution_margin' || metric === 'refund_ratio') return '%';
  return metric === 'average_order_value' ? '元/笔' : '元';
}
