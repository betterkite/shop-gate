import { describe, expect, it } from 'vitest';

import { retailPriceInventoryPageTemplate } from './retail-scaffold-templates';

describe('retail BI scaffold language', () => {
  it('keeps trend labels aligned with the rendered PV/cart/buy series', () => {
    const template = retailPriceInventoryPageTemplate();

    expect(template).toContain('页面浏览量（PV）');
    expect(template).toContain('加购（Cart）');
    expect(template).toContain('购买（Buy）');
    expect(template).toContain('同一个数量刻度');
    expect(template).toContain('成交总额（GMV）占比');
    expect(template).toContain('需关注库存商品数');
    expect(template).toContain('不等于立即补货');
    expect(template).toContain('库存、销量、浏览量和购买转化');
    expect(template).toContain('原因与建议');
    expect(template).not.toContain('GMV 份额');
    expect(template).not.toContain('库存风险数');
    expect(template).not.toContain('<th>诊断</th>');
    expect(template).not.toContain('PV/UV/购买');
    expect(template).not.toContain('蓝=页面浏览量（PV）');
  });
});
