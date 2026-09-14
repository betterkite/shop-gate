import { describe, expect, it } from 'vitest';

import {
  extractRetailTemplateRequirements,
  inferRetailOutputIntent,
  matchRetailTemplateCoverage,
} from './template-routing';
import { serializeRetailVisualizationTemplate, RETAIL_VISUALIZATION_TEMPLATES } from './visualization-templates';

describe('retail output routing and template coverage', () => {
  it('routes explicit chat mode to answer without requiring a dashboard template', () => {
    expect(inferRetailOutputIntent({
      query: '库销比最差的 10 个商品是哪些？',
      rewriteIntent: 'dashboard',
      requestedOutputMode: 'chat',
    })).toBe('answer');
  });

  it('routes a simple list question to answer when no dashboard is requested', () => {
    expect(inferRetailOutputIntent({
      query: '库销比最差的 10 个商品是哪些？',
      rewriteIntent: 'dashboard',
    })).toBe('answer');
  });

  it('keeps an explicit dashboard request as a dashboard route', () => {
    expect(inferRetailOutputIntent({
      query: '库销比最差的 10 个商品是哪些？生成经营看板。',
      rewriteIntent: 'answer',
    })).toBe('dashboard');
  });

  it('matches inventory metrics and dimensions to the standard inventory template', () => {
    const template = serializeRetailVisualizationTemplate('price_inventory', {
      instruction: '库存相对销量偏高的 10 个商品，查看页面浏览量和购买转化率，生成经营看板。',
    });
    const result = matchRetailTemplateCoverage({
      query: '库存相对销量偏高的 10 个商品，查看页面浏览量和购买转化率，生成经营看板。',
      outputIntent: 'dashboard',
      template,
    });
    expect(result.routeStatus).toBe('dashboard');
    expect(result.missingMetrics).toEqual([]);
    expect(result.requestedMetrics).toEqual(expect.arrayContaining([
      'sell_through_ratio',
      'page_views',
      'buy_conversion',
    ]));
    expect(result.requestedDimensions).toContain('item');
  });

  it('blocks a dashboard when the selected template does not cover price elasticity', () => {
    const template = serializeRetailVisualizationTemplate('price_inventory', {
      instruction: '分析价格弹性，生成经营看板。',
    });
    const result = matchRetailTemplateCoverage({
      query: '分析价格弹性，生成经营看板。',
      outputIntent: 'dashboard',
      template,
    });
    expect(result.routeStatus).toBe('template_not_supported');
    expect(result.missingMetrics).toContain('price_elasticity');
  });

  it('declares coverage for every registered template', () => {
    for (const template of RETAIL_VISUALIZATION_TEMPLATES) {
      expect(template.coverage.metrics.length, template.templateId).toBeGreaterThan(0);
      expect(template.coverage.dimensions.length, template.templateId).toBeGreaterThan(0);
      expect(template.coverage.outputModes, template.templateId).toContain('dashboard');
    }
  });

  it('extracts only explicitly requested metrics and dimensions', () => {
    expect(extractRetailTemplateRequirements('按渠道比较 GMV 和购买转化率')).toEqual({
      metrics: ['purchases', 'buy_conversion', 'gmv'],
      dimensions: ['channel'],
    });
  });
});
