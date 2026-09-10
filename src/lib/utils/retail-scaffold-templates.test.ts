import { describe, expect, it } from 'vitest';

import { retailPriceInventoryPageTemplate } from './retail-scaffold-templates';

describe('retail BI scaffold language', () => {
  it('keeps trend labels aligned with the rendered PV/cart/buy series', () => {
    const template = retailPriceInventoryPageTemplate();

    expect(template).toContain('页面浏览量（PV）');
    expect(template).toContain('加购（Cart）');
    expect(template).toContain('购买（Buy）');
    expect(template).toContain('同一个数量刻度');
    expect(template).not.toContain('PV/UV/购买');
    expect(template).not.toContain('蓝=页面浏览量（PV）');
  });
});
