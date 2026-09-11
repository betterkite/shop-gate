import { describe, expect, it } from 'vitest';

import { serializeRetailVisualizationTemplate } from './visualization-templates';

describe('retail visualization template selection', () => {
  it('selects the P28 BI template for expanded analytics requests', () => {
    const template = serializeRetailVisualizationTemplate('price_inventory', {
      instruction: '生成经营分析看板，查看商品阶段、渠道和毛利',
    });
    expect(template.templateId).toBe('analytics-bi');
    expect(template.variantId).toBe('p28-expanded');
  });

  it('keeps the standard price-inventory template for inventory-only requests', () => {
    const template = serializeRetailVisualizationTemplate('price_inventory', {
      instruction: '库销比最差的商品有哪些？',
    });
    expect(template.templateId).toBe('price-inventory');
    expect(template.variantId).toBe('base');
  });
});
