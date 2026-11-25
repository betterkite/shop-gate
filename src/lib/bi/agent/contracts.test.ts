import { describe, expect, it } from 'vitest';
import { biAgentSubmissionSchema } from './contracts';
const input = { dataset_id: 'business', dataset_version: 2, conversation_id: '7cac1e7c-4889-4d10-a244-97f98f699a2a',
  expected_conversation_version: 0, idempotency_key: 'question-1', instruction: '  当前范围净销售额是多少？ ',
  model: 'deepseek-v4-flash', page_scope: { module: 'overview', category: '', product_ids: ['p2', 'p1', 'p2'] } };
describe('BI assistant input contract', () => {
  it('normalizes selections and retains an explicitly empty category', () => {
    const value = biAgentSubmissionSchema.parse(input);
    expect(value.instruction).toBe('当前范围净销售额是多少？');
    expect(value.page_scope).toMatchObject({ category: '', product_ids: ['p1', 'p2'], refund_basis: 'payment' });
  });
  it.each([{ actor_id: 'admin' }, { session_id: 'session' }, { tools: ['shell'] }, { model: 'unknown' },
    { dataset_version: true }, { expected_conversation_version: -1 }, { instruction: '  ' },
    { instruction: 'x'.repeat(8001) }, { instruction: '\u0000' }, { instruction: '\ud800' }])('rejects forged or ambiguous input %o', (change) => {
    expect(biAgentSubmissionSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
  it.each([{ start: '2026-02-30' }, { start: '2026-10-02', end: '2026-10-01' },
    { category: '\u0000' }, { sql: 'select *' }, { product_ids: ['../private'] }, { product_ids: Array(101).fill('p1') }])('rejects invalid scope %o', (change) => {
    expect(biAgentSubmissionSchema.safeParse({ ...input, page_scope: { ...input.page_scope, ...change } }).success).toBe(false);
  });
});
