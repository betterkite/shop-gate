import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overview } from '@/lib/bi/overview-contracts';
const mocks = vi.hoisted(() => ({ access: vi.fn(), redirect: vi.fn(), search: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/bi/gateway-scope', () => ({ getBiWorkspaceAccess: mocks.access }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useSearchParams: mocks.search, useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/auth/AuthUserMenu', () => ({ AuthUserMenu: () => React.createElement('span', null, '账号') }));
vi.mock('@/components/ui/theme-toggle', () => ({ ThemeToggle: () => React.createElement('button', null, '切换主题') }));
import Page from './page';
import { AuthorizationError } from '@/lib/auth/authorization';
import { OverviewCoverage, OverviewIndicators } from './OverviewDashboard';
import { OverviewTrend } from './OverviewTrend';

function manual(): Overview {
  const range = { start: '2026-07-01', end: '2026-07-02', refund_basis: 'payment' as const };
  const metrics = { net_sales: '164.00', accounted_contribution: '121.00', order_count: 2, average_order_value: '130.00',
    contribution_margin: '0.73780488', refund_ratio: '0.36923077', accounted_revenue: '260.00', coverage_ratio: '1.00000000' };
  const quality = { known_sales_cny: '260.00', unknown_cost_lines: 0 };
  return { workspace_id: 'account:a', dataset_id: 'official', version: 2, accounting_revision: 2, algorithm_version: 'test-only', state: 'ready',
    range, recorded_start: '2026-07-01', data_cutoff: '2026-07-02', summary: { metrics, quality }, previous: null,
    comparison: { net_sales: { current: '164.00', previous: null, difference: null, growth_ratio: null, state: 'history_insufficient' } },
    trend: { interval: 'day', rows: [{ key: '2026-07-01', start: '2026-07-01', end: '2026-07-01', state: 'recorded', metrics, quality },
      { key: '2026-07-02', start: '2026-07-02', end: '2026-07-02', state: 'no_records', metrics: null, quality: null }] },
    channels: { rows: [], total: 0, page: 1, page_size: 20 }, attention: { rows: [], total: 0, page: 1, page_size: 20 }, targets: null };
}

describe('real authenticated overview entry and accounting presentation', () => {
  beforeEach(() => { mocks.search.mockReset().mockReturnValue(new URLSearchParams()); mocks.access.mockReset().mockResolvedValue({ workspaceId: 'account:a', canManage: true });
    mocks.redirect.mockReset().mockImplementation((href: string) => { throw new Error(`REDIRECT:${href}`); }); });
  it('offers a real data selection, retained theme and data center without invented live values', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('经营总览'); expect(html).toContain('切换主题'); expect(html).toContain('数据集与导入');
    expect(html).toContain('请选择经营数据'); expect(html).not.toContain('121.00'); expect(html).not.toContain('已生成看板');
  });
  it('keeps exact range through login and rejects ambiguous repeated query input', async () => {
    mocks.access.mockRejectedValue(new AuthorizationError('AUTHENTICATION_REQUIRED', 401, 'private'));
    await expect(Page({ searchParams: Promise.resolve({ dataset_id: '001', channel_id: '002', detail: 'store', detail_page: '2' }) })).rejects.toThrow('REDIRECT:/login?next=');
    const next = decodeURIComponent(mocks.redirect.mock.calls[0][0]); expect(next).toContain('dataset_id=001'); expect(next).toContain('detail_page=2');
    mocks.access.mockClear();
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ start: ['2026-07-01', '2026-08-01'] }) }));
    expect(html).toContain('分析范围无效'); expect(mocks.access).not.toHaveBeenCalled();
  });
  it('does not expose private auth/service exceptions or select another workspace', async () => {
    mocks.access.mockRejectedValue(new Error('private-dsn-secret'));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('暂时无法确认访问权限'); expect(html).not.toContain('private-dsn'); expect(html).not.toContain('请选择经营数据');
  });
  it('uses exact manual121 values and warns when prior history is insufficient', () => {
    const html = renderToStaticMarkup(React.createElement(OverviewIndicators, { data: manual() }));
    for (const text of ['164.00', '121.00', '130.00', '73.78%', '36.92%', '前期记录不足']) expect(html).toContain(text);
    expect(html).not.toContain('GMV');
  });
  it('distinguishes recorded zero, missing accounting, no records and incompatible refund basis', () => {
    const data = manual(); data.summary.metrics.net_sales = '0.00'; data.summary.metrics.contribution_margin = null;
    data.summary.metrics.refund_ratio = null; data.range.refund_basis = 'occurred';
    let html = renderToStaticMarkup(React.createElement(OverviewIndicators, { data }));
    expect(html).toContain('0.00'); expect(html).toContain('待核算'); expect(html).toContain('此口径不计算');
    data.trend.rows = []; data.state = 'empty';
    html = renderToStaticMarkup(React.createElement(OverviewIndicators, { data }));
    expect(html).toContain('无经营记录'); expect(html).not.toContain('121.00');
  });
  it('shows the ledger-known sales amount without silently replacing the incomplete total', () => {
    const data = manual(); data.summary.metrics.net_sales = null; data.summary.metrics.coverage_ratio = null; data.summary.quality.unknown_cost_lines = 1;
    const html = renderToStaticMarkup(React.createElement(OverviewCoverage, { data }));
    expect(html).toContain('260.00'); expect(html).toContain('暂不计算'); expect(html).toContain('缺少商品成本依据');
    expect(html).toContain('不替代完整净销售额');
  });
  it('retains gaps and all dates with 20-row paging and an accessible table', () => {
    const data = manual(); data.trend.rows = Array.from({ length: 23 }, (_, i) => ({ ...data.trend.rows[i % 2],
      key: `2026-07-${String(i + 1).padStart(2, '0')}`, start: `2026-07-${String(i + 1).padStart(2, '0')}`, end: `2026-07-${String(i + 1).padStart(2, '0')}` }));
    const html = renderToStaticMarkup(React.createElement(OverviewTrend, { trend: data.trend, page: 2, navigate: vi.fn(), onSelect: vi.fn() }));
    expect(html).toContain('共 23 项'); expect(html).toContain('第 2 / 2 页'); expect(html).toContain('没有经营记录');
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr /g)).toHaveLength(3);
  });
});
