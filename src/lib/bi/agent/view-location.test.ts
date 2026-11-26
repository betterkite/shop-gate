import { describe, expect, it } from 'vitest';
import { overviewLoginReturnPath, overviewQuery, overviewUrl, readOverviewLocation } from '../overview-contracts';
import { findAssistantView, readAssistantViews, updateAssistantView, type AssistantViewState } from './view-location';

const run = '10000000-0000-4000-8000-000000000001';
const result = '20000000-0000-4000-8000-000000000001';
const conversation = '30000000-0000-4000-8000-000000000001';
const view: AssistantViewState = { kind: 'evidence', run, result, page: 3, open: true };
const chart: AssistantViewState = { kind: 'chart', run, result, metric: 'net_sales', page: 2 };
const read = (href: string) => readOverviewLocation(href.split('?')[1]);

describe('assistant view URL recovery', () => {
  it('restores independent evidence, chart and definition positions through login and history URLs', () => {
    const original = `/bi/overview?dataset_id=official&conversation=${conversation}&store_id=001&question_page=2`;
    const views = [view, chart, { kind: 'definition', run, open: true } as const];
    const href = overviewUrl(original, { assistantViews: views });
    const location = read(href);
    expect(location).toMatchObject({ assistantViews: views, questionPage: 2, storeId: '001' });
    expect(overviewQuery(location)).toEqual(overviewQuery(read(original)));
    const login = overviewLoginReturnPath(Object.fromEntries(new URL(href, 'http://shopgate.local').searchParams));
    expect(read(login).assistantViews).toEqual(views);
    const next = overviewUrl(href, { assistantViews: updateAssistantView(views, { ...chart, page: 3 }) });
    expect(findAssistantView(read(next).assistantViews, chart).page).toBe(3);
    // A browser Back uses the earlier URL, not a local component page counter.
    expect(findAssistantView(read(href).assistantViews, chart).page).toBe(2);
    expect(findAssistantView(read(next).assistantViews, view)).toEqual(view);
    expect(read(overviewUrl(next, { questionPage: 4 })).assistantViews).toEqual(read(next).assistantViews);
    expect(read(overviewUrl(next, { start: '2026-07-01' })).assistantViews).toEqual(read(next).assistantViews);
  });
  it('discards prior display positions on conversation, workspace and dataset changes', () => {
    const href = overviewUrl(`/bi/overview?dataset_id=a&conversation=${conversation}&question_page=3`, { assistantViews: [view] });
    for (const change of [{ conversationId: run }, { conversationId: undefined }, { workspaceId: 'other' }, { datasetId: 'b' }]) {
      expect(read(overviewUrl(href, change))).toMatchObject({ assistantViews: [], questionPage: 1 });
    }
    expect(() => readOverviewLocation(new URLSearchParams({ assistant_views: JSON.stringify([view]) }).toString())).toThrow();
  });
  it('retains a closed evidence page and drops only default positions', () => {
    const closed = updateAssistantView([view, chart], { ...view, open: false });
    expect(findAssistantView(closed, view)).toEqual({ ...view, open: false });
    expect(updateAssistantView(closed, { ...view, page: 1, open: false })).toEqual([chart]);
    expect(updateAssistantView([chart], { ...chart, page: 1 })).toEqual([]);
    const otherMetric: AssistantViewState = { ...chart, metric: 'accounted_contribution' };
    expect(updateAssistantView([chart], otherMetric)).toEqual([chart, otherMetric]);
  });
  it('rejects ambiguous, unbounded and executable-looking state without silently truncating', () => {
    for (const value of [[view, view], [{ ...view, page: 0 }], [{ ...view, page: 1_000_001 }],
      [{ ...view, run: 'other' }], [{ ...chart, metric: '<script>' }], [{ ...view, actor: 'another' }],
      [{ kind: 'sql', run, result }], { ...view }, Array.from({ length: 65 }, (_, i) => ({ ...chart, metric: `metric_${'a'.repeat(i + 1)}` }))]) {
      expect(() => readAssistantViews(JSON.stringify(value))).toThrow();
    }
    expect(() => readAssistantViews('[')).toThrow();
    expect(() => readAssistantViews(' '.repeat(12_001))).toThrow();
    const encoded = encodeURIComponent(JSON.stringify([view]));
    expect(() => readOverviewLocation(`conversation=${conversation}&assistant_views=${encoded}&assistant_views=${encoded}`)).toThrow();
  });
});
