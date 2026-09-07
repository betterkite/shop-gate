import { describe, expect, it } from 'vitest';

import { inferExpectedTemplateFromTask } from './retail-validation';

describe('validation template intent (retail)', () => {
  it('keeps daily brief on its capability template even when the query mentions numbers', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'daily_brief',
      question: '生成 12 月 3 日的经营日报，重点看环比和异动类目。',
      entities: [],
    })).toBe('daily-brief');
  });

  it('maps traffic funnel through the capability contract', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'traffic_funnel',
      question: '加购未购买的行为漏斗哪个环节流失最大？',
      entities: ['cat:10051'],
    })).toBe('funnel-analysis');
  });

  it('keeps price-inventory on its capability template', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'price_inventory',
      question: '库销比最差的 10 个商品是哪些？',
      entities: ['item:1000329'],
    })).toBe('price-inventory');
  });

  it('uses catalog structure for an explicit comparison capability', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'catalog_structure',
      question: '对比家居类目和数码类目的转化。',
      entities: ['cat:10002', 'cat:10001'],
    })).toBe('catalog-structure');
  });

  it('fails closed instead of inferring a template from keywords', () => {
    expect(inferExpectedTemplateFromTask({
      question: '对比家居类目和数码类目的转化。',
      entities: ['cat:10002', 'cat:10001'],
    })).toBeNull();
  });
});
