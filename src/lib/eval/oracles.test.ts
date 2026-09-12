import { describe, expect, it } from 'vitest';

import { evaluateOracleAssertions } from './oracles';

describe('evaluation factual oracles', () => {
  it('evaluates numeric, structural and forbidden-language assertions', () => {
    const result = evaluateOracleAssertions({
      assertions: [
        { id: 'dataset', target: 'finalData', path: 'dataset_id', operator: 'equals', value: 'retail-demo' },
        { id: 'events', target: 'finalData', path: 'behavior_events', operator: 'length_gte', value: 2 },
        { id: 'unsafe', target: 'page', operator: 'not_matches', value: '稳赚|保证收益' },
      ],
      targets: {
        finalData: { dataset_id: 'retail-demo', behavior_events: [{}, {}] },
        sources: {},
        quality: {},
        page: '本页面只提供经营信息，不构成销量保证。',
      },
    });
    expect(result).toMatchObject({ passed: true, warning: false });
    expect(result.checks).toHaveLength(3);
    expect(result.checks[2]).toMatchObject({
      target: 'page',
      operator: 'not_matches',
    });
  });

  it('separates warning assertions from hard oracle failures', () => {
    const result = evaluateOracleAssertions({
      assertions: [{
        id: 'optional-copy',
        target: 'page',
        operator: 'contains',
        value: '数据截止',
        severity: 'warning',
      }],
      targets: { finalData: {}, sources: {}, quality: {}, page: '暂无截止时间' },
    });
    expect(result.passed).toBe(true);
    expect(result.warning).toBe(true);
  });
});
