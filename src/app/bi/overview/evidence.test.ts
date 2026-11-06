import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EvidenceEvents } from './QualityEvidence';
import type { QualityEvidence } from '@/lib/bi/overview-contracts';

describe('ledger reminder source presentation', () => {
  it('distinguishes original expense from an unknown selected allocation', () => {
    const events: QualityEvidence['events'] = { record_key: '0001', page: 1, page_size: 20, total: 1, rows: [{
      key: 'expense:0001:line-1', kind: 'expense', source_id: '0001', date: '2026-07-01',
      order_id: 'order-1', line_id: 'line-1', refund_id: null, expense_id: '0001', store_name: '示例店铺', listing_name: '棉服',
      paid_at: null, occurred_at: '2026-07-01T00:00:00+00:00', currency: 'EUR', original_amount: '6.00',
      amount_cny: null, cost_cny: null, source_amount_cny: null, reason: '缺少费用汇率，不能确定该商品应承担的费用。',
    }] };
    const html = renderToStaticMarkup(React.createElement(EvidenceEvents, { events }));
    expect(html).toContain('费用记录：0001'); expect(html).toContain('EUR'); expect(html).toContain('原币整笔费用');
    expect(html).toContain('本范围已分摊费用'); expect(html).toContain('待核算'); expect(html).toContain('不等于当前商品应承担金额');
    expect(html).not.toContain('>0.00<');
  });
  it('does not claim a source outside the selected scope is empty accounting data', () => {
    const html = renderToStaticMarkup(React.createElement(EvidenceEvents, { events: {
      record_key: 'foreign', page: 1, page_size: 20, total: 0, rows: [],
    } }));
    expect(html).toContain('不在当前提醒及搜索范围内');
  });
});
