import { describe, expect, it } from 'vitest';

import { buildDatasetActivationUrl } from './dataset-selector';

describe('buildDatasetActivationUrl', () => {
  it('replaces only the dataset while preserving the current BI view context', () => {
    expect(buildDatasetActivationUrl(
      'http://localhost:3000/analytics-workbench?view=drilldown&dimension=item&value=1000009&project_id=project-demo#results',
      'retail-demo-imported-v1',
    )).toBe('/analytics-workbench?view=drilldown&dimension=item&value=1000009&project_id=project-demo&dataset_id=retail-demo-imported-v1#results');
  });

  it('adds dataset_id when the current URL did not have one', () => {
    expect(buildDatasetActivationUrl('/analytics-workbench?view=overview', 'retail-demo-imported-v1'))
      .toBe('/analytics-workbench?view=overview&dataset_id=retail-demo-imported-v1');
  });
});
