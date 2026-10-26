import { describe, expect, it } from 'vitest';
import { catalogSchema, dataLocationUrl, dataLoginReturnPath, datasetSchema, decimalLabel, inferResource, jobSchema,
  batchCanCommit, batchSchema, JOB_ERROR_LABELS, previewCanCommit, readDataLocation, RESOURCES, sameDatasetSnapshot, StableRequestKeys,
  UPLOAD_LIMITS, validateUploads, type DataSnapshot } from './data-contracts';

const dataset = datasetSchema.parse({ workspace_id: 'account:a', dataset_id: 'official', name: '经营数据',
  source_kind: 'import', version: 2, reporting_currency: 'CNY', state: 'active' });
const now = Date.parse('2026-10-25T08:00:00Z');
const job = jobSchema.parse({ workspace_id: 'account:a', dataset_id: 'official', job_id: 'job-a', kind: 'preview_import',
  base_version: 2, state: 'ready_preview', result: { preview_id: 'preview-a', preview_expires_at: '2026-10-25T08:15:00Z' },
  cancel_requested: false, attempts: 1, error_code: null, created_at: '2026-10-25T08:00:00Z',
  updated_at: '2026-10-25T08:00:00Z', expires_at: '2026-10-26T08:00:00Z', expired: false, stage_label: '预览已完成' });

describe('data center scope, exact values and confirmation contracts', () => {
  it('reads safe URL state with no arbitrary identity, seed-as-date or hidden defaults', () => {
    expect(readDataLocation('workspace_id=project-a&dataset_id=official&dataset_page=2&job_page=3&job_id=job-a')).toEqual({ workspaceId: 'project-a', datasetId: 'official', datasetPage: 2, jobPage: 3, jobId: 'job-a' });
    expect(readDataLocation('workspace_id=../bad&dataset_page=-2&job_page=1.5&seed=20251203')).toEqual({ workspaceId: undefined, datasetId: undefined, datasetPage: 1, jobPage: 1, jobId: undefined });
  });
  it('changes pages/details without dropping selected dataset or browser context', () => {
    expect(dataLocationUrl('/bi/data?workspace_id=project-a&dataset_id=official&job_id=job-a#tasks', { jobPage: 2 })).toBe('/bi/data?workspace_id=project-a&dataset_id=official&job_id=job-a&job_page=2#tasks');
    expect(dataLocationUrl('/bi/data?dataset_id=official&dataset_page=2', { datasetPage: 1 })).toBe('/bi/data?dataset_id=official');
  });
  it('keeps a validated dataset/task/page through reauthentication without caller URLs or identity', () => {
    expect(dataLoginReturnPath({ workspace_id: 'project-a', dataset_id: 'official', dataset_page: '2', job_page: '3', job_id: 'job-a', next: 'https://foreign.test/', actor_id: 'forged' }))
      .toBe('/bi/data?workspace_id=project-a&dataset_id=official&dataset_page=2&job_page=3&job_id=job-a');
    expect(dataLoginReturnPath({ dataset_id: '../bad', job_id: ['one', 'two'], job_page: '-1', dataset_page: '1' })).toBe('/bi/data');
  });
  it('switching a dataset invalidates old object filters, version and job selection', () => {
    const url = dataLocationUrl('/bi/data?workspace_id=project-a&dataset_id=old&job_id=old-job&job_page=4&version=3&sku_id=old-sku&dataset_page=2', { datasetId: 'new' });
    expect(url).toBe('/bi/data?workspace_id=project-a&dataset_id=new&dataset_page=2');
  });
  it('switching a workspace resets all old dataset/actor-specific context', () => {
    expect(dataLocationUrl('/bi/data?workspace_id=project-a&dataset_id=old&job_id=old-job&sku_id=private', { workspaceId: 'project-b' })).toBe('/bi/data?workspace_id=project-b');
    expect(dataLocationUrl('/bi/data?workspace_id=project-a&dataset_id=old', { workspaceId: undefined })).toBe('/bi/data');
  });
  it('restores historical batch links and clears their context on dataset/workspace changes', () => {
    expect(readDataLocation('dataset_id=official&batch_id=batch-a&batch_page=2')).toMatchObject({ batchId: 'batch-a', batchPage: 2 });
    expect(dataLocationUrl('/bi/data?dataset_id=official&batch_page=2&batch_id=batch-a', { batchPage: 3 })).toBe('/bi/data?dataset_id=official&batch_page=3&batch_id=batch-a');
    expect(dataLocationUrl('/bi/data?dataset_id=official&batch_page=2&batch_id=batch-a', { datasetId: 'new' })).toBe('/bi/data?dataset_id=new');
    expect(dataLoginReturnPath({ dataset_id: 'official', batch_id: 'batch-a', batch_page: '2', actor_id: 'forged' })).toBe('/bi/data?dataset_id=official&batch_page=2&batch_id=batch-a');
  });
  it('allows only the current owner preview with both original expiration checks and write authority', () => {
    const batch = batchSchema.parse({ workspace_id: 'account:a', dataset_id: 'official', batch_id: 'batch-a',
      state: 'preview', row_count: 3, error_count: 0, version: 2, based_on_version: 2,
      created_at: '2026-10-25T08:00:00Z', expires_at: '2026-10-25T08:15:00Z',
      expired: false, owned_by_current_user: true, can_confirm: true, preview_id: 'preview-a',
      preview_expires_at: '2026-10-25T08:15:00Z' });
    expect(batchCanCommit(batch, dataset, true, now)).toBe(true);
    expect(batchCanCommit(batch, dataset, false, now)).toBe(false);
    for (const patch of [{ state: 'committed' as const }, { owned_by_current_user: false },
      { can_confirm: false }, { workspace_id: 'foreign' }, { dataset_id: 'other' }, { based_on_version: 1 }, { based_on_version: null },
      { expired: true }, { preview_id: null }, { expires_at: null }, { preview_expires_at: '2026-10-25T08:00:00Z' }]) {
      expect(batchCanCommit({ ...batch, ...patch }, dataset, true, now)).toBe(false);
    }
  });
  it('only permits current unexpired explicitly manageable previews', () => {
    expect(previewCanCommit(job, dataset, true, now)).toBe(true);
    expect(previewCanCommit(job, dataset, false, now)).toBe(false);
    for (const update of [ { state: 'committed' as const }, { base_version: 1 }, { dataset_id: 'other' },
      { workspace_id: 'foreign' }, { expired: true }, { cancel_requested: true },
      { result: { preview_id: 'preview-a', preview_expires_at: '2026-10-25T08:00:00Z' } },
      { result: { preview_id: 'preview-a' } }, { result: { preview_id: '../forged', preview_expires_at: '2026-10-25T08:15:00Z' } },
    ]) expect(previewCanCommit({ ...job, ...update }, dataset, true, now)).toBe(false);
  });
  it('unknown never becomes zero and decimal formatting does not lose large-money precision', () => {
    expect(decimalLabel(null)).toBe('待核算'); expect(decimalLabel(undefined)).toBe('待核算');
    expect(decimalLabel('9999999999999999.99')).toBe('9,999,999,999,999,999.99');
    expect(decimalLabel('-121.00')).toBe('-121.00'); expect(decimalLabel('0.00')).toBe('0.00');
    expect(decimalLabel('0.99990000', true)).toBe('99.99%'); expect(decimalLabel('1.00000000', true)).toBe('100.00%');
    expect(decimalLabel('0.00000000', true)).toBe('0.00%'); expect(decimalLabel('NaN')).toBe('—');
  });
  it('explains timeout and input failures without presenting a failed task as completed', () => {
    expect(JOB_ERROR_LABELS.BI_JOB_TIMEOUT).toContain('已回滚');
    expect(JOB_ERROR_LABELS.BI_JOB_INPUT_INVALID).toContain('尚未写入');
    expect(JOB_ERROR_LABELS.BI_JOB_CONFLICT).toContain('重新预览');
  });
  it('rejects mixed workspace/dataset/accounting versions before displaying facts', () => {
    const result = { workspace_id: 'account:a', dataset_id: 'official', version: 2, accounting_revision: 2 } as DataSnapshot;
    expect(sameDatasetSnapshot('account:a', dataset, result)).toBe(true);
    for (const patch of [{ workspace_id: 'other' }, { dataset_id: 'other' }, { version: 1 }, { accounting_revision: 1 }]) {
      expect(sameDatasetSnapshot('account:a', dataset, { ...result, ...patch })).toBe(false);
    }
  });
  it('recognizes all twelve standard template filenames without inventing an unmatched file type', () => {
    expect(RESOURCES).toHaveLength(12);
    for (const resource of RESOURCES) expect(inferResource(`shopgate-${resource}-v1.csv`)).toBe(resource);
    expect(inferResource('arbitrary-orders.csv')).toBe(''); expect(inferResource('商品.csv')).toBe('');
  });
  it('requires explicit resource mapping and enforces file count and decoded size before reading files', () => {
    expect(() => validateUploads([{ name: 'orders.csv', size: UPLOAD_LIMITS.file, resource: 'orders' }])).not.toThrow();
    for (const files of [[], [{ name: 'a.csv', size: 0, resource: 'products' }],
      [{ name: 'a.csv', size: UPLOAD_LIMITS.file + 1, resource: 'products' }],
      [{ name: 'a.csv', size: 1, resource: '' }], Array.from({ length: 37 }, () => ({ name: 'a.csv', size: 1, resource: 'products' })),
      Array.from({ length: 4 }, () => ({ name: 'a.csv', size: UPLOAD_LIMITS.file, resource: 'products' })),
    ]) expect(() => validateUploads(files)).toThrow();
  });
  it('reuses the original operation key after an uncertain response without reusing it for changed contents', () => {
    const keys = new StableRequestKeys();
    expect(keys.get('same', () => 'request-a')).toBe('request-a');
    expect(keys.get('same', () => 'request-b')).toBe('request-a');
    expect(keys.get('different', () => 'request-b')).toBe('request-b');
  });
  it('strict presentation schemas reject unknown source types rather than labelling them formal or zero', () => {
    expect(datasetSchema.safeParse({ ...dataset, source_kind: 'unknown' }).success).toBe(false);
    expect(datasetSchema.safeParse({ ...dataset, version: 0 }).success).toBe(false);
    expect(jobSchema.safeParse({ ...job, state: 'almost_done' }).success).toBe(false);
    expect(catalogSchema.safeParse({ metrics: [], templates: [{ resource: 'fake' }] }).success).toBe(false);
  });
});
