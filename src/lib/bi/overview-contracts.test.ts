import { describe, it, expect } from 'vitest';
import { overviewLoginReturnPath, overviewQuery, overviewUrl, readOverviewLocation, scopeMatches } from './overview-contracts';

describe('overview URL scope isolation and restore', () => {
  it('preserves dates, precision-safe IDs, paging and details through safe login redirects', () => {
    const href = overviewLoginReturnPath({ workspace_id: 'project-a', dataset_id: 'official', start: '2026-07-01', end: '2026-07-09',
      channel_id: '001', store_id: '002', detail: 'sku', detail_page: '2', trend_page: '3', detail_search: '棉服', next: 'https://foreign.test/' });
    const scope = readOverviewLocation(href.split('?')[1]);
    expect(scope).toMatchObject({ workspaceId: 'project-a', datasetId: 'official', channelId: '001', storeId: '002', detailDimension: 'sku', detailPage: 2, trendPage: 3, detailSearch: '棉服' });
    expect(href).not.toContain('foreign'); expect(overviewQuery(scope)).toMatchObject({ channel_ids: ['001'], store_ids: ['002'], start: '2026-07-01', end: '2026-07-09' });
  });
  it('never carries old workspace or dataset item selections into a new dataset', () => {
    const before = '/bi/overview?workspace_id=team&dataset_id=old&channel_id=001&store_id=002&start=2026-07-01&target_page=2&edit_store_id=002';
    expect(overviewUrl(before, { datasetId: 'new' })).toBe('/bi/overview?workspace_id=team&dataset_id=new');
    expect(overviewUrl(before, { workspaceId: undefined })).toBe('/bi/overview');
  });
  it('clears dependent stores and detail selections when changing global platform, preserving the data scope', () => {
    const after = readOverviewLocation(overviewUrl('/bi/overview?dataset_id=official&channel_id=001&store_id=002&detail_channel_id=001&detail_store_id=002&channel_page=2&trend_page=2', { channelId: 'other' }).split('?')[1]);
    expect(after).toMatchObject({ datasetId: 'official', channelId: 'other', channelPage: 1, trendPage: 1 });
    expect(after.storeId).toBeUndefined(); expect(after.detailChannelId).toBeUndefined(); expect(after.detailStoreId).toBeUndefined();
  });
  it('restores detail paging without changing top-level dates, target page or platform', () => {
    const after = readOverviewLocation(overviewUrl('/bi/overview?dataset_id=official&channel_id=001&start=2026-07-01&target_page=3&detail=store&detail_search=abc', { detailPage: 2 }).split('?')[1]);
    expect(after).toMatchObject({ channelId: '001', start: '2026-07-01', targetPage: 3, detailPage: 2, detailDimension: 'store', detailSearch: 'abc' });
  });
  it.each(['start=2026-02-30', 'start=0000-01-01', 'start=2026-07-09&end=2026-07-01', 'target_month=2026-07-02', 'detail=__proto__', 'channel_page=0', 'detail_descending=no', 'dataset_id=one&dataset_id=two', 'channel_id=%2Fetc%2Fpasswd'])('rejects invalid or ambiguous scope %s', (query) => {
    expect(() => readOverviewLocation(query)).toThrow();
  });
  it('rejects repeated parameters before the server renders a client with a different scope', () => {
    expect(() => overviewLoginReturnPath({ dataset_id: ['a', 'b'] })).toThrow();
  });
  it('does not accept a mismatched workspace, dataset or accounting version', () => {
    const data = { workspace_id: 'account:a', dataset_id: '001', version: 3, accounting_revision: 3 };
    expect(scopeMatches('account:a', { dataset_id: '001', version: 3 }, data)).toBe(true);
    for (const change of [{ workspace_id: 'account:b' }, { dataset_id: '002' }, { version: 2 }, { accounting_revision: 2 }]) {
      expect(scopeMatches('account:a', { dataset_id: '001', version: 3 }, { ...data, ...change })).toBe(false);
    }
  });
});
