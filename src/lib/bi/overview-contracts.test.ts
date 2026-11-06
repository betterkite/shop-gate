import { describe, it, expect } from 'vitest';
import { overviewLoginReturnPath, overviewQuery, overviewUrl, readOverviewLocation, referenceOptions, referenceSelection, scopeMatches } from './overview-contracts';

describe('overview URL scope isolation and restore', () => {
  it('restores exact alert, source and both pages without changing accounting filters', () => {
    const href = overviewLoginReturnPath({ dataset_id: 'official', store_id: '001', quality: 'unknown_refund_lines', evidence_page: '2',
      evidence_record: 'line-001', evidence_event_page: '3', evidence_search: '棉服', evidence_sort: 'date', evidence_descending: 'true' });
    const location = readOverviewLocation(href.split('?')[1]);
    expect(location).toMatchObject({ qualityKey: 'unknown_refund_lines', evidencePage: 2, evidenceEventPage: 3, evidenceRecord: 'line-001', evidenceSearch: '棉服', evidenceSort: 'date', evidenceDescending: true });
    expect(overviewQuery(location)).toEqual(overviewQuery(readOverviewLocation('dataset_id=official&store_id=001')));
    const sorted = readOverviewLocation(overviewUrl(href, { evidenceSort: 'name' }).split('?')[1]);
    expect(sorted).toMatchObject({ evidencePage: 1, evidenceEventPage: 1, evidenceRecord: undefined });
    expect(readOverviewLocation(overviewUrl(href, { filterKind: 'store' }).split('?')[1]).qualityKey).toBeUndefined();
    expect(readOverviewLocation(overviewUrl(href, { datasetId: 'new' }).split('?')[1]).qualityKey).toBeUndefined();
    expect(() => readOverviewLocation('quality=sql')).toThrow();
    expect(() => readOverviewLocation('quality=unknown_cost_lines&quality=unknown_expenses')).toThrow();
  });
  it('keeps directory pages/search/order without transaction dates in the directory request', () => {
    const href = overviewLoginReturnPath({ dataset_id: 'official', channel_id: 'pdd', store_id: '001', start: '2026-07-01', filter: 'listing', filter_page: '2', filter_search: '棉服', filter_sort: 'key', filter_descending: 'true' });
    const location = readOverviewLocation(href.split('?')[1]);
    expect(referenceOptions(location)).toEqual({ kind: 'listing', search: '棉服', sort: 'key', descending: true, page: 2, page_size: 20, channel_id: 'pdd', store_id: '001' });
    expect(location.start).toBe('2026-07-01');
    expect(referenceOptions(readOverviewLocation('filter=product&channel_id=pdd&store_id=001'))).not.toHaveProperty('store_id');
  });
  it('distinguishes uncategorized from no category and clears incompatible child selections', () => {
    const selected = overviewUrl('/bi/overview?product_id=p001&sku_id=001&category=old', referenceSelection('category', { key: '', name: '未分类' }));
    const location = readOverviewLocation(selected.split('?')[1]);
    expect(location.category).toBe(''); expect(location.productId).toBeUndefined(); expect(location.skuId).toBeUndefined();
    expect(overviewQuery(location)).toHaveProperty('category', '');
    expect(referenceOptions(location)).toHaveProperty('category', '');
    expect(overviewQuery(readOverviewLocation(overviewUrl(selected, { category: undefined }).split('?')[1]))).not.toHaveProperty('category');
  });
  it('sets known parent identities when choosing a store or specification and clears old descendants', () => {
    const store = overviewUrl('/bi/overview?channel_id=old&store_id=old&listing_id=old', referenceSelection('store', { key: '001', name: '店铺', channel_id: 'pdd', store_id: '001' }));
    expect(readOverviewLocation(store.split('?')[1])).toMatchObject({ channelId: 'pdd', storeId: '001', listingId: undefined });
    const sku = overviewUrl('/bi/overview?product_id=old&sku_id=old', referenceSelection('sku', { key: '002', name: '规格', product_id: 'p002' }));
    expect(readOverviewLocation(sku.split('?')[1])).toMatchObject({ productId: 'p002', skuId: '002' });
    expect(() => referenceSelection('store', { key: 'bad/id', name: '无效' })).toThrow();
  });
  it('opening a target editor preserves the implicit month and data query, and closes other drawers', () => {
    const before = readOverviewLocation('dataset_id=official&target_page=2&filter=store');
    const after = readOverviewLocation(overviewUrl('/bi/overview?dataset_id=official&target_page=2&filter=store', { editStoreId: '001' }).split('?')[1]);
    expect(after).toMatchObject({ targetPage: 2, targetMonth: undefined, editStoreId: '001', filterKind: undefined });
    expect(overviewQuery(after)).toEqual(overviewQuery(before));
  });
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
  it.each(['start=2026-02-30', 'start=0000-01-01', 'start=2026-07-09&end=2026-07-01', 'target_month=2026-07-02', 'detail=__proto__', 'filter=__proto__', 'filter_page=0', 'filter=store&filter=product', 'filter_sort=sql', 'channel_page=0', 'detail_descending=no', 'dataset_id=one&dataset_id=two', 'channel_id=%2Fetc%2Fpasswd'])('rejects invalid or ambiguous scope %s', (query) => {
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
