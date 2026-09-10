import { describe, expect, it } from 'vitest';

import { buildRetailBiOverview } from './bi-dataset';

describe('retail BI overview dataset', () => {
  it('combines factual behaviour rows with disclosed synthetic operating projections', () => {
    const result = buildRetailBiOverview({
      window: { start: '2026-01-01', end: '2026-01-02' },
      meta: { master_item_count: 1000 },
      funnelDaily: {
        rows: [
          { stat_date: '2026-01-01', pv: 1000, pv_users: 600, fav: 100, cart: 80, buy: 20 },
          { stat_date: '2026-01-02', pv: 1200, pv_users: 700, fav: 120, cart: 90, buy: 30 },
        ],
      },
      categories: {
        rows: [{ category_id: 1, category_name: '数码', pv: 1000, buy: 20, gmv: 2000, buy_conversion: 0.02 }],
      },
      inventoryRisk: {
        health: { total_items: 10, in_stock_items: 8, moving_items: 3, stagnant_items: 5, out_of_stock_items: 2, moving_share: 0.375 },
        items: [{ item_id: 1, title: '商品 A', category_id: 1, price: 100, stock: 50, sold: 2, views: 1000, sell_through_ratio: 225, buy_conversion: 0.002 }],
      },
      itemPool: { items: [{ item_id: 1, title: '商品 A', pv: 1000, buy: 2, gmv: 200, price: 100 }] },
      channels: { rows: [{ channel: '旗舰店', item_count: 1, pv: 1000, buy: 20, gmv: 2000, buy_conversion: 0.02, gmv_share: 1 }] },
    });

    expect(result.synthetic_fields).toContain('profit_proxy');
    expect(result.kpis).toHaveLength(8);
    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toMatchObject({ uv: 600, buy: 20 });
    expect(result.inventory_anomalies[0]).toMatchObject({ risk_level: '高' });
    expect(result.inventory_health).toMatchObject({ moving_items: 3, stagnant_items: 5, moving_share: 0.375 });
    expect(result.channels).toHaveLength(1);
    expect(result.actions).toHaveLength(3);
  });
});
