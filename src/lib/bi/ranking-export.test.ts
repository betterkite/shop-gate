import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportRanking } from './ranking-export';

const scope = { workspace_id: 'w', dataset_id: 'd', version: 2 };
const query = { dimension: 'listing', search: '杭州', sort: 'refund_amount', descending: true };

function page(n: number, total: number, patch = {}) {
  return { ...scope, accounting_revision: 2, range: { start: null, end: null, refund_basis: 'payment' },
    page_size: 100, page: n, total, summary: { metrics: {}, quality: {} },
    rows: Array.from({ length: Math.min(100, total - (n - 1) * 100) }, (_, i) => ({
      key: String((n - 1) * 100 + i).padStart(6, '0'), name: '=样例,"门店"',
      metrics: { net_sales: '-1.20', order_count: 1, contribution_margin: '0.125000' }, quality: {},
    })), ...patch };
}

function reply(data: ReturnType<typeof page>) {
  return Response.json({ success: true, data });
}

afterEach(() => vi.unstubAllGlobals());

describe('full filtered ranking export', () => {
  it('includes all rows across pages under one version, sorting and scope', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(page(1, 201)))
      .mockResolvedValueOnce(reply(page(2, 201))).mockResolvedValueOnce(reply(page(3, 201)));
    vi.stubGlobal('fetch', fetch);
    const { file, total } = await exportRanking(scope, query, new AbortController().signal);
    expect(total).toBe(201);
    expect(await file.text()).toContain('"000200","\'=样例,""门店""","-1.20","待核算","12.50%"');
    for (const [index, call] of fetch.mock.calls.entries()) {
      expect(JSON.parse(call[1].body)).toMatchObject({ ...scope, query: { ...query, page: index + 1, page_size: 100 } });
    }
  });

  it.each([{ version: 3 }, { workspace_id: 'elsewhere' }, { rows: [] }, { total: 202 }])(
    'rejects incomplete or changed pages before providing a file', async (change) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(page(1, 201)))
        .mockResolvedValueOnce(reply(page(2, 201, change))));
      await expect(exportRanking(scope, query, new AbortController().signal)).rejects.toThrow('范围发生变化');
    });

  it('exports standard units as text and keeps incomplete cost coverage visible', async () => {
    const data = page(1, 1);
    const rows = [{ ...data.rows[0], metrics: { ...data.rows[0].metrics, standard_quantity: '5.0000',
      costed_quantity: '4.0000', average_unit_price: '52.0000', weighted_unit_cost: '14.0000' },
      quality: { quantity_by_unit: { '=自定义单位': '5.0000' } } }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...data, rows })));
    const { file } = await exportRanking(scope, { dimension: 'sku' }, new AbortController().signal);
    const [header, row] = (await file.text()).trim().split('\r\n');
    expect(header).toContain('历史加权单位成本（元/标准单位）');
    expect(row).toContain('"52.0000","14.0000","4.0000","\'=自定义单位"');
  });

  it('exports exact and known channel fees including adjustments, missing exchange rates and zero fees', async () => {
    const data = page(1, 1);
    const rows = [{ ...data.rows[0], expense_breakdown: {
      platform: { amount: '-2.50', known_amount: '-2.50' }, advertising: { amount: null, known_amount: '1.40' },
    } }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...data, rows })));
    const { file } = await exportRanking(scope, { dimension: 'channel' }, new AbortController().signal);
    const [header, line] = (await file.text()).trim().split('\r\n');
    expect(header).toContain('"平台费用（元）","平台费用已核算部分（元）"');
    expect(line).toMatch(/"-2.50","-2.50","0.00","0.00","0.00","0.00","待核算","1.40","0.00","0.00"$/);
  });

  it.each(['store', 'channel'])('includes sales and cost per standard unit for a selected SKU by %s', async (dimension) => {
    const data = page(1, 1);
    const rows = [{ ...data.rows[0], name: '一号店', metrics: { ...data.rows[0].metrics,
      standard_quantity: '6.0000', average_unit_price: '12.0000', weighted_unit_cost: '4.5000', costed_quantity: '6.0000' },
      quality: { quantity_by_unit: { 件: '6.0000' } } }];
    const fetch = vi.fn().mockResolvedValue(reply({ ...data, rows }));
    vi.stubGlobal('fetch', fetch);
    const { file } = await exportRanking(scope, { dimension, sku_ids: ['000073'] }, new AbortController().signal);
    const [header, first] = (await file.text()).trim().split('\r\n');
    expect(header).toContain('"历史加权单位成本（元/标准单位）","有成本依据的标准销量（标准单位）","标准单位"');
    expect(first).toContain('"6.0000","12.0000","4.5000","6.0000","件"');
    expect(JSON.parse(fetch.mock.calls[0][1].body).query.sku_ids).toEqual(['000073']);
  });

  it('returns the column headers when the filter has no matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(page(1, 0))));
    const result = await exportRanking(scope, query, new AbortController().signal);
    expect(result.total).toBe(0);
    expect((await result.file.text()).trim().split('\r\n')).toHaveLength(1);
  });
});
