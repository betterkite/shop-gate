import { describe, expect, it } from 'vitest';

import { assessRetailDatasetIdentity } from './data-identity';

const PLAN = {
  runId: 'run-1',
  datasetId: 'retail-test',
  window: { start: '2017-11-25', end: '2017-12-03' },
  plannedEntities: { categoryIds: [10051], itemIds: [] },
};

const BASE_FINAL = {
  runId: 'run-1',
  datasetId: 'retail-test',
  generatedAt: '2025-09-06T12:00:00Z',
  window: { start: '2017-11-25', end: '2017-12-03' },
  plannedEntities: { categoryIds: [10051], itemIds: [] },
  datasets: {
    funnel: { window: { start: '2017-11-25', end: '2017-12-03' }, rows: [] },
    categories: {
      window: { start: '2017-11-25', end: '2017-12-03' },
      rows: [{ category_id: 10051, gmv: 100 }],
    },
  },
};

describe('retail dataset identity', () => {
  it('accepts a dataset that matches the plan', () => {
    const assessment = assessRetailDatasetIdentity(PLAN, BASE_FINAL);
    expect(assessment.ready).toBe(true);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.runId).toBe('run-1');
  });

  it('rejects run id mismatch', () => {
    const assessment = assessRetailDatasetIdentity(PLAN, {
      ...BASE_FINAL,
      runId: 'run-2',
    });
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('final_run_id_mismatch');
  });

  it('rejects final data from a different dataset', () => {
    const assessment = assessRetailDatasetIdentity(PLAN, {
      ...BASE_FINAL,
      datasetId: 'retail-other',
    });
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('final_dataset_id_mismatch');
  });

  it('rejects window mismatch inside datasets', () => {
    const assessment = assessRetailDatasetIdentity(PLAN, {
      ...BASE_FINAL,
      datasets: {
        ...BASE_FINAL.datasets,
        summary: { window: { start: '2017-11-26', end: '2017-12-03' } },
      },
    });
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('summary_window_mismatch');
  });

  it('rejects categories outside the planned scope', () => {
    const assessment = assessRetailDatasetIdentity(PLAN, {
      ...BASE_FINAL,
      datasets: {
        ...BASE_FINAL.datasets,
        categories: {
          window: { start: '2017-11-25', end: '2017-12-03' },
          rows: [
            { category_id: 10051, gmv: 100 },
            { category_id: 10086, gmv: 50 },
          ],
        },
      },
    });
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toContain('categories_categories_outside_plan');
  });

  it('allows any category under whole-dataset scope', () => {
    const wholePlan = { ...PLAN, plannedEntities: { categoryIds: [], itemIds: [] } };
    const assessment = assessRetailDatasetIdentity(wholePlan, BASE_FINAL);
    expect(assessment.ready).toBe(true);
  });
});
