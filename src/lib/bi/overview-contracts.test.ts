import { describe, it, expect } from 'vitest';
import { scopedBiAgentQuery } from './agent/result-contracts';
import { sectionHref, overviewLoginReturnPath, overviewQuery, overviewUrl, readOverviewLocation, referenceOptions, referenceSelection, scopeMatches } from './overview-contracts';

describe('overview URL scope isolation and restore', () => {
  it('restores private conversation pages and clears them when changing dataset or workspace', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const href = overviewLoginReturnPath({ dataset_id: 'official', conversation: id, conversation_page: '2', question_page: '3' });
    expect(readOverviewLocation(href.split('?')[1])).toMatchObject({ conversationId: id, conversationPage: 2, questionPage: 3 });
    expect(readOverviewLocation(overviewUrl(href, { start: '2026-07-01' }).split('?')[1]).conversationId).toBe(id);
    for (const change of [{ datasetId: 'other' }, { workspaceId: 'other' }]) {
      expect(readOverviewLocation(overviewUrl(href, change).split('?')[1])).toMatchObject({ conversationId: undefined, conversationPage: 1, questionPage: 1 });
    }
    expect(() => readOverviewLocation('conversation=bad')).toThrow();
  });
  it('restores selected evidence rows on reload and clears them across private conversations', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const other = '10000000-0000-4000-8000-000000000002';
    const selection = { result_id: other, positions: [2, 125] };
    const url = overviewUrl('/bi/overview', { datasetId: 'demo', conversationId: id, selection });
    expect(readOverviewLocation(overviewUrl(url, { questionPage: 2 }).split('?')[1]).selection).toEqual(selection);
    for (const change of [{ conversationId: other }, { datasetId: 'replacement' }, { selection: undefined }]) {
      expect(readOverviewLocation(overviewUrl(url, change).split('?')[1]).selection).toBeUndefined();
    }
    expect(() => overviewUrl(url, { selection: { ...selection, positions: [0] } })).toThrow();
  });
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


describe('business analysis navigation', () => {
  it('preserves the analytical scope and clears private conversation and pagination state on module change', () => {
    const location = readOverviewLocation('workspace_id=w&dataset_id=d&channel_id=pdd&start=2026-07-01&rank_search=abc&rank_page=2&conversation=de305d54-75b4-431b-adb2-eb6b9e546014');
    const target = new URL(sectionHref('stores', location), 'https://shopgate.local');
    expect(target.pathname).toBe('/bi/stores');
    expect(Object.fromEntries(target.searchParams)).toEqual({ workspace_id: 'w', dataset_id: 'd', channel_id: 'pdd', start: '2026-07-01', rank_search: 'abc' });
  });
  it('returns to the first results page when the ranking or the selected range changes', () => {
    for (const change of [{ rankSearch: '样例' }, { rankGrain: 'sku' as const }, { storeId: '001' }]) {
      expect(overviewUrl('/bi/products?dataset_id=d&rank_page=9', change)).not.toContain('rank_page');
    }
    expect(() => readOverviewLocation('rank_sort=not_a_metric')).toThrow();
  });
});

describe('transaction source location', () => {
  it('preserves the selected order on paging and resets it when the operating scope changes', () => {
    const url = overviewUrl('/bi/stores', { datasetId: 'sample', storeId: '001', sourceKind: 'sale',
      sourceOrderId: 'o1', sourcePage: 3, sourceSearch: '000原单', sourceDescending: false });
    const parse = (value: string) => readOverviewLocation(value.split('?')[1] ?? '');
    expect(parse(url)).toMatchObject({ sourceOrderId: 'o1', sourcePage: 3, sourceDescending: false });
    expect(parse(overviewUrl(url, { sourceKind: 'refund' }))).toMatchObject({ sourceOrderId: 'o1', sourcePage: 1, sourceKind: 'refund' });
    expect(parse(overviewUrl(url, { storeId: '002' })).sourceOrderId).toBeUndefined();
    expect(parse(overviewUrl(url, { detailDimension: 'order' })).sourceKind).toBeUndefined();
    expect(parse(overviewUrl(url, { datasetId: 'other' })).sourceOrderId).toBeUndefined();
    expect(() => readOverviewLocation('source_kind=refund&detail=order')).toThrow();
  });
});

describe('product performance scope', () => {
  it.each([
    ['low_margin', 'sku'], ['missing_cost', 'product'], ['missing_mapping', 'listing'],
  ] as const)('keeps the %s classification window in cross-module links and model comparisons', (condition, grain) => {
    const url = overviewUrl('/bi/products', { datasetId: 'sample', start: '2026-07-01', end: '2026-07-03', groupCondition: condition,
      conditionGrain: grain, conditionStart: '2026-07-01', conditionEnd: '2026-07-03' });
    const loc = readOverviewLocation(url.split('?')[1]);
    const store = readOverviewLocation(sectionHref('stores', loc).split('?')[1]);
    const scope = overviewQuery(store);
    const frozen = { group_condition: condition, condition_grain: grain, condition_start: '2026-07-01', condition_end: '2026-07-03' };
    expect(scope).toMatchObject(frozen);
    expect(scopedBiAgentQuery({ module: 'stores', ...scope }, { period: 'previous', dimension: 'channel' })).toMatchObject({
      ...frozen, start: '2026-06-28', end: '2026-06-30',
    });
    expect(overviewQuery(readOverviewLocation(overviewUrl(url, { groupCondition: undefined }).split('?')[1]))).not.toHaveProperty('group_condition');
    expect(() => readOverviewLocation('group_condition=low_margin&condition_grain=sku')).toThrow();
  });
});

it('restores mapping directory filters and resets its page when its scope changes', () => {
  const url = overviewUrl('/bi/products?dataset_id=sample', { mappingPage: 2, mappingDate: '2026-07-01',
    mappingSearch: '000001', mappingStatus: 'missing', mappingSort: 'name', mappingDescending: true });
  const read = (s: string) => readOverviewLocation(s.split('?')[1] ?? '');
  expect(read(url)).toMatchObject({ mappingPage: 2, mappingDate: '2026-07-01', mappingSearch: '000001',
    mappingStatus: 'missing', mappingSort: 'name', mappingDescending: true });
  expect(read(overviewUrl(url, { mappingStatus: 'all' })).mappingPage).toBe(1);
  expect(read(overviewUrl(url, { storeId: '001' })).mappingPage).toBe(1);
  expect(read(overviewUrl(url, { datasetId: 'other' })).mappingSearch).toBe('');
});


it('restores store cost history and clears its item on dataset or scope changes', () => {
  const open = overviewUrl('/bi/products?dataset_id=manual', { costListingId: '0001' });
  const page2 = overviewUrl(open, { costPage: 2, costSearch: '导入' });
  const read = (url: string) => readOverviewLocation(url.split('?')[1] ?? '');
  expect(read(page2)).toMatchObject({ costListingId: '0001', costPage: 2, costSearch: '导入' });
  expect(read(overviewUrl(page2, { mappingDate: '2026-07-02' })).costPage).toBe(1);
  for (const change of [{ datasetId: 'other' }, { channelId: 'other' }, { sourceKind: 'sale' as const }]) {
    expect(read(overviewUrl(page2, change)).costListingId).toBeUndefined();
  }
});


it('restores profit grouping and sorting after login, and restarts paging on regroup', () => {
  const href = overviewLoginReturnPath({ dataset_id: 'sample', profit_group: 'sku', profit_view: 'change', rank_page: '3', rank_sort: 'logistics_expense' }, 'profit');
  const selected = readOverviewLocation(href.split('?')[1]);
  expect(href.split('?')[0]).toBe('/bi/profit');
  expect(selected).toMatchObject({ profitGroup: 'sku', profitView: 'change', rankPage: 3, rankSort: 'logistics_expense' });
  expect(readOverviewLocation(overviewUrl(href, { profitGroup: 'store' }).split('?')[1])).toMatchObject({ profitGroup: 'store', rankPage: 1 });
});
