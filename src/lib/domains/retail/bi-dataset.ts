/**
 * Build the cross-theme retail BI dataset used by generated workspaces.
 *
 * Behaviour events are factual for the selected window. Price, inventory,
 * channel, cost and profit fields are deterministic projections from the
 * existing synthetic master data and are disclosed as synthetic.
 */

export type RetailBiRecord = Record<string, unknown>;

export interface RetailBiOverview extends RetailBiRecord {
  kpis: RetailBiRecord[];
  daily: RetailBiRecord[];
  categories: RetailBiRecord[];
  channels: RetailBiRecord[];
  price_bands: RetailBiRecord[];
  top_traffic_items: RetailBiRecord[];
  inventory_anomalies: RetailBiRecord[];
  high_traffic_low_conversion: RetailBiRecord[];
  inventory_health: RetailBiRecord;
  actions: string[];
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rows(value: unknown): RetailBiRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is RetailBiRecord => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator, 6) : 0;
}

function riskLevel(item: RetailBiRecord): '高' | '中' | '低' {
  const ratioValue = number(item.sell_through_ratio);
  const views = number(item.views);
  const conversion = number(item.buy_conversion);
  if (ratioValue >= 30 || (views >= 500 && conversion < 0.002)) return '高';
  if (ratioValue >= 10 || conversion < 0.005) return '中';
  return '低';
}

export function buildRetailBiOverview(params: {
  window: { start: string; end: string };
  meta?: RetailBiRecord | null;
  funnelDaily?: RetailBiRecord | null;
  categories?: RetailBiRecord | null;
  inventoryRisk?: RetailBiRecord | null;
  itemPool?: RetailBiRecord | null;
  channels?: RetailBiRecord | null;
  summary?: RetailBiRecord | null;
}): RetailBiOverview {
  const daily = rows(params.funnelDaily?.rows);
  const categoryRows = rows(params.categories?.rows);
  const inventoryRows = rows(params.inventoryRisk?.items);
  const inventoryHealth = params.inventoryRisk?.health && typeof params.inventoryRisk.health === 'object'
    ? params.inventoryRisk.health as RetailBiRecord
    : {
      total_items: inventoryRows.length,
      in_stock_items: inventoryRows.filter((item) => number(item.stock) > 0).length,
      moving_items: inventoryRows.filter((item) => number(item.stock) > 0 && number(item.sold) > 0).length,
      stagnant_items: inventoryRows.filter((item) => number(item.stock) > 0 && number(item.sold) <= 0).length,
      out_of_stock_items: inventoryRows.filter((item) => number(item.stock) <= 0).length,
      moving_share: ratio(
        inventoryRows.filter((item) => number(item.stock) > 0 && number(item.sold) > 0).length,
        inventoryRows.filter((item) => number(item.stock) > 0).length,
      ),
      source: '风险样本回退估算',
    };
  const itemPoolRows = rows(params.itemPool?.items);
  const channelRows = rows(params.channels?.rows ?? params.channels);

  const averagePrice = inventoryRows.length > 0
    ? inventoryRows.reduce((sum, item) => sum + number(item.price), 0) / inventoryRows.length
    : 0;
  const totals: Record<string, number> = daily.reduce<Record<string, number>>(
    (acc, point) => {
      acc.pv += number(point.pv);
      acc.uv += number(point.pv_users ?? point.uv);
      acc.fav += number(point.fav);
      acc.cart += number(point.cart);
      acc.buy += number(point.buy);
      return acc;
    },
    { pv: 0, uv: 0, fav: 0, cart: 0, buy: 0 },
  );
  const summaryTotals = params.summary?.totals && typeof params.summary.totals === 'object'
    ? params.summary.totals as RetailBiRecord
    : null;
  const totalGmv = number(summaryTotals?.gmv) > 0
    ? number(summaryTotals?.gmv) * Math.max(daily.length, 1)
    : totals.buy * averagePrice;
  const stockValueSample = inventoryRows.reduce(
    (sum, item) => sum + number(item.stock) * number(item.price),
    0,
  );
  const masterItemCount = Math.max(number(params.meta?.master_item_count), inventoryRows.length, 1);
  const estimatedInventoryValue = inventoryRows.length > 0
    ? stockValueSample / inventoryRows.length * masterItemCount
    : 0;
  const overallConversion = ratio(totals.buy, totals.pv);
  const estimatedCost = totalGmv * 0.78;
  const estimatedProfit = totalGmv - estimatedCost;

  const dailyRows: RetailBiRecord[] = daily.map((point) => {
    const buy = number(point.buy);
    const gmv = buy * averagePrice;
    return {
      stat_date: point.stat_date,
      pv: number(point.pv),
      uv: number(point.pv_users ?? point.uv),
      fav: number(point.fav),
      cart: number(point.cart),
      buy,
      gmv: round(gmv, 2),
      buy_conversion: ratio(buy, number(point.pv)),
      source: '行为数据 + 商品价格估算',
    };
  });

  const categoryMetrics: RetailBiRecord[] = categoryRows.map((category): RetailBiRecord => {
    const pv = number(category.pv);
    const buy = number(category.buy);
    const gmv = number(category.gmv);
    const categoryInventory = inventoryRows.filter(
      (item) => Number(item.category_id) === Number(category.category_id),
    );
    const stockValue = categoryInventory.reduce(
      (sum, item) => sum + number(item.stock) * number(item.price),
      0,
    );
    return {
      ...category,
      traffic_share: ratio(pv, totals.pv),
      gmv_share: ratio(gmv, totalGmv),
      conversion_gap: round(ratio(buy, pv) - overallConversion, 6),
      inventory_value_sample: round(stockValue, 2),
      inventory_risk_count: categoryInventory.filter((item) => riskLevel(item) === '高').length,
    };
  });

  const topTrafficItems: RetailBiRecord[] = itemPoolRows
    .map((item): RetailBiRecord => ({
      ...item,
      buy_conversion: number(item.buy_conversion ?? ratio(number(item.buy), number(item.pv))),
      traffic_share: ratio(number(item.pv), totals.pv),
      conversion_gap: round(number(item.buy_conversion ?? ratio(number(item.buy), number(item.pv))) - overallConversion, 6),
    }))
    .sort((left, right) => number(right['pv']) - number(left['pv']))
    .slice(0, 8);

  const inventoryAnomalies: RetailBiRecord[] = inventoryRows
    .map((item): RetailBiRecord => ({
      ...item,
      risk_level: riskLevel(item),
      inventory_value: round(number(item.stock) * number(item.price), 2),
      diagnosis: number(item.views) > 0 && number(item.buy_conversion) < overallConversion
        ? '有流量但转化低，优先检查商品承接与价格'
        : number(item.sold) === 0
          ? '窗口内无购买事件，库销比按地板值计算'
          : '关注库存周转与补货节奏',
    }))
    .sort((left, right) => number(right['sell_through_ratio']) - number(left['sell_through_ratio']))
    .slice(0, 10);

  const priceBands = [
    { label: '0–50', min: 0, max: 50 },
    { label: '50–200', min: 50, max: 200 },
    { label: '200–500', min: 200, max: 500 },
    { label: '500–1000', min: 500, max: 1000 },
    { label: '1000+', min: 1000, max: Number.POSITIVE_INFINITY },
  ].map((band) => {
    const matched = inventoryRows.filter((item) => number(item.price) >= band.min && number(item.price) < band.max);
    return {
      label: band.label,
      item_count: matched.length,
      inventory_value: round(matched.reduce((sum, item) => sum + number(item.price) * number(item.stock), 0), 2),
      average_conversion: ratio(
        matched.reduce((sum, item) => sum + number(item.sold), 0),
        matched.reduce((sum, item) => sum + number(item.views), 0),
      ),
    };
  });

  const highTrafficLowConversion: RetailBiRecord[] = categoryMetrics
    .filter((category) => number(category['pv']) >= Math.max(1, totals.pv * 0.05) && number(category['conversion_gap']) < 0)
    .sort((left, right) => number(left['conversion_gap']) - number(right['conversion_gap']))
    .slice(0, 6);

  const actions = [
    inventoryAnomalies.some((item) => item.risk_level === '高')
      ? '优先复核高库销比商品，区分零销量、低转化和流量不足三类原因。'
      : '当前库存风险处于可观察范围，继续跟踪库销比变化。',
    highTrafficLowConversion.length > 0
      ? `对 ${highTrafficLowConversion.length} 个高流量低转化类目下钻商品详情，检查页面承接和价格。`
      : '当前没有达到阈值的高流量低转化类目。',
    '成本、毛利和库存金额为演示估算，只用于看板练习，不代表真实财务或采购结果。',
  ];

  return {
    schema_version: 1,
    window: params.window,
    scope: '真实行为窗口 + 合成经营主数据投影',
    synthetic_fields: ['price', 'stock', 'channel', 'cost_proxy', 'profit_proxy', 'inventory_value'],
    kpis: [
      { id: 'gmv', label: '成交总额（GMV）', value: round(totalGmv, 2), source: '购买次数 × 商品价格（估算）' },
      { id: 'pv', label: '页面浏览量（PV）', value: totals.pv, source: '打开商品页面的次数' },
      { id: 'uv', label: '独立访客（UV）', value: totals.uv, source: '看过商品页面的不同用户数' },
      { id: 'buy', label: '购买次数（Buy）', value: totals.buy, source: '商品被买下的次数' },
      { id: 'buy_conversion', label: '购买转化率（Buy / PV）', value: overallConversion, source: '购买次数 ÷ 页面浏览量' },
      { id: 'avg_order_value', label: '平均每次购买金额（AOV）', value: round(totalGmv / Math.max(totals.buy, 1), 2), source: '成交总额 ÷ 购买次数（估算）' },
      { id: 'inventory_value', label: '库存金额估算', value: round(estimatedInventoryValue, 2), source: '库存数量 × 商品价格（估算）' },
      { id: 'profit_proxy', label: '毛利估算', value: round(estimatedProfit, 2), source: '按估算毛利率计算' },
    ],
    daily: dailyRows,
    categories: categoryMetrics,
    channels: channelRows,
    price_bands: priceBands,
    top_traffic_items: topTrafficItems,
    inventory_anomalies: inventoryAnomalies,
    high_traffic_low_conversion: highTrafficLowConversion,
    inventory_health: inventoryHealth,
    actions,
    limitations: [
      '只统计当前数据窗口，窗口外没有数据。',
      '商品价格、库存、渠道、成本、毛利和库存金额为演示或估算数据。',
      '本看板没有混入其他数据集，避免用户、商品和时间范围对不上。',
    ],
  };
}
