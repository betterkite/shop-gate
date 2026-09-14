import { describe, expect, it } from 'vitest';

import {
  aggregateReport,
  parseBenchmarkArgs,
  redactResult,
  wilsonLowerPercent,
} from '../../../scripts/evals/run-commerce-benchmarks.js';

describe('commerce benchmark runner', () => {
  it('parses value and repeated options without silently dropping them', () => {
    const parsed = parseBenchmarkArgs([
      '--model', 'deepseek-v4-flash',
      '--repeat=2',
      '--case', 'R01',
      '--case=R02',
      '--keep-projects',
    ]);

    expect('help' in parsed).toBe(false);
    if ('help' in parsed) return;
    expect(parsed.values.get('model')).toBe('deepseek-v4-flash');
    expect(parsed.values.get('repeat')).toBe('2');
    expect(parsed.repeated.get('case')).toEqual(['R01', 'R02']);
    expect(parsed.flags.has('keep-projects')).toBe(true);
    expect(() => parseBenchmarkArgs(['--ignored-flag'])).toThrow('不会被静默忽略');
  });

  it('aggregates physical repeats into pass, first-pass and stability metrics', () => {
    const options = {
      visibility: 'public',
      model: 'deepseek-v4-flash',
      cli: 'pi',
      repeat: 2,
      selectedCases: [],
      limit: null,
      concurrency: 1,
    };
    const report = aggregateReport(options, [
      {
        campaign: 'retail-r1',
        exitCode: 0,
        signal: null,
        reportPath: 'tmp/task-e2e-retail-r1-latest.json',
        report: {
          checkedAt: '2026-09-14T00:00:00.000Z',
          results: [
            { id: 'R01', model: 'deepseek-v4-flash', passed: true },
            { id: 'R02', model: 'deepseek-v4-flash', passed: false },
          ],
          summary: { ready: 1, recorded: 2 },
        },
      },
      {
        campaign: 'retail-r2',
        exitCode: 0,
        signal: null,
        reportPath: 'tmp/task-e2e-retail-r2-latest.json',
        report: {
          checkedAt: '2026-09-14T00:02:00.000Z',
          results: [
            { id: 'R01', model: 'deepseek-v4-flash', passed: true },
            { id: 'R02', model: 'deepseek-v4-flash', passed: true },
          ],
          summary: { ready: 2, recorded: 2 },
        },
      },
    ]);

    expect(report.summary).toMatchObject({
      total: 4,
      passedCount: 3,
      firstPassRate: 50,
      stabilityRate: 50,
      repairRate: 0,
    });
    expect(report.summary.stabilityConfidenceLower).toBeGreaterThan(0);
    expect(report.summary.stabilityConfidenceLower).toBeLessThan(100);
  });

  it('redacts non-public result identity and prompt-bearing fields', () => {
    const result = redactResult({
      id: 'hidden-1',
      projectId: 'project-e2e-hidden-hidden-1',
      requestId: 'request-hidden-1',
      question: '隐藏问题',
      model: 'deepseek-v4-flash',
      capabilityId: 'traffic_funnel',
      state: 'failed',
      passed: false,
      elapsedMs: 10,
      failures: ['原始错误'],
    });

    expect(result).not.toHaveProperty('question');
    expect(result).not.toHaveProperty('projectId');
    expect(result.failures).toEqual(['redacted']);
    expect(result.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('uses a conservative Wilson lower bound for stability', () => {
    expect(wilsonLowerPercent(10, 10)).toBeLessThan(100);
    expect(wilsonLowerPercent(0, 10)).toBe(0);
  });
});
