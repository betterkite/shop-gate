import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PiAgentDurableRunSession } from '@/lib/services/pi-agent-run-store';
import { PrismaAgentRuntimeRepository } from '@/lib/agent/runtime/prisma-repository';
import { submitBiAgentQuestion, cancelBiAgentQuestion } from './requests';
import { biAgentPageScopeSchema } from './contracts';
import { collectBiAgentResult, saveBiAgentAnswer, readBiAgentAnswer, readBiAgentResultPage,
  readBiAgentChart, inspectBiAgentResultPage, type BiAgentResultFence } from './results';
import { collectBiAgentMetricSource } from './metric-sources';
import type { BiAgentAuthority } from './authorization';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const prefix = `bi_result_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!databaseUrl)('BI original-version results (real PostgreSQL)', () => {
  let a: PrismaClient, b: PrismaClient; let seq = 0;
  const users: string[] = [], projects: string[] = [];
  const unique = () => `${prefix}:${++seq}`;
  async function identity() {
    const id = unique(), sessionId = unique(); users.push(id);
    await a.authUser.create({ data: { id, name: 'Owned result test', email: `${id}@example.invalid` } });
    await a.authSession.create({ data: { id: sessionId, token: unique(), userId: id, expiresAt: new Date(Date.now() + 3_600_000) } });
    return { actorId: id, sessionId, workspaceId: `account:${id}` };
  }
  async function running(authority?: BiAgentAuthority) {
    const actor = authority ?? await identity();
    const accepted = await submitBiAgentQuestion(actor, { dataset_id: 'same-data', dataset_version: 2,
      conversation_id: randomUUID(), expected_conversation_version: 0, idempotency_key: unique(),
      instruction: '比较全部商品的净销售额', model: 'deepseek-v4-flash', page_scope: { module: 'overview' } },
    { client: a, resolvePage: async () => biAgentPageScopeSchema.parse({ module: 'overview', start: '2026-09-01', end: '2026-09-30' }) });
    const repository = new PrismaAgentRuntimeRepository(a);
    const session = await PiAgentDurableRunSession.claimPending({ repository, runId: accepted.request.runs[0].id,
      expectedVersion: 0, heartbeatEnabled: false });
    const run = session.run; await session.close();
    const fence: BiAgentResultFence = { runId: run.id, leaseOwner: run.leaseOwner!, fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken };
    return { actor, fence, repository };
  }
  const read = (count = 125) => vi.fn(async (actor: BiAgentAuthority, dataset: string, version: number, query: Record<string, unknown>) => {
    const page = Number(query.page), start = (page - 1) * 100;
    return { workspace_id: actor.workspaceId, dataset_id: dataset, version, accounting_revision: version,
      algorithm_version: 'fixture-accounting-v1', data_cutoff: '2026-09-30',
      range: { start: '2026-09-01', end: '2026-09-30', refund_basis: 'payment' },
      summary: { metrics: { net_sales: '164.00', accounted_contribution: '121.00' }, quality: {} },
      total: count, page, page_size: 100,
      rows: Array.from({ length: Math.min(100, Math.max(0, count - start)) }, (_, i) => ({
        key: `p${start + i}`, name: `商品${start + i}`, metrics: { net_sales: String(count - start - i) }, quality: {} })) };
  });
  const signal = () => new AbortController().signal;
  const answer = (id: string) => ({ kind: 'answer', text: '当前范围净销售额为164元，完整商品排名见表格。',
    evidence_ids: [id], views: [{ result_id: id, kind: 'table', metric: 'net_sales' }] });
  async function complete(fence: BiAgentResultFence, repository: PrismaAgentRuntimeRepository) {
    const run = (await repository.getRun(fence.runId))!;
    await repository.completeRun({ ...fence, expectedVersion: run.version, status: 'completed', turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheMissInputTokens: 0, reasoningTokens: 0 } });
  }
  beforeAll(async () => {
    vi.stubEnv('SHOPGATE_AUTH_MODE', 'local'); vi.stubEnv('SHOPGATE_AUTH_SECRET', 'owned-results-test-auth-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'unused-results-test-credential'); vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1');
    a = new PrismaClient({ datasourceUrl: databaseUrl! }); b = new PrismaClient({ datasourceUrl: databaseUrl! });
    await Promise.all([a.$connect(), b.$connect()]);
  });
  afterAll(async () => {
    try {
      await a.agentExecutionScope.deleteMany({ where: { OR: [{ ownerUserId: { in: users } }, { sharedProjectId: { in: projects } }] } });
      await a.project.deleteMany({ where: { id: { in: projects } } });
      await a.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { vi.unstubAllEnvs(); await Promise.allSettled([a.$disconnect(), b.$disconnect()]); }
  });

  it('saves all 125 rows, exposes 20-row pages only after terminal completion, and survives a new client', async () => {
    const { actor, fence, repository } = await running(); const ledger = read();
    const result = await collectBiAgentResult(fence, unique(), { dimension: 'product' }, signal(), { client: a, read: ledger });
    expect(result.total).toBe(125); expect(result.preview).toHaveLength(20); expect(ledger).toHaveBeenCalledTimes(2);
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a);
    expect(await readBiAgentAnswer(actor, fence.runId, b)).toEqual({ status: 'running', answer: null });
    await expect(readBiAgentResultPage(actor, fence.runId, result.evidence_id, 1, b)).rejects.toThrow();
    await complete(fence, repository);
    // A later ledger version may no longer serve v2. Historical reads use only
    // original persisted pages, never issue a fresh ledger query.
    ledger.mockRejectedValue(new Error('New dataset version'));
    const fresh = new PrismaClient({ datasourceUrl: databaseUrl! });
    try {
      const all = [];
      for (let page = 1; page <= 7; page++) {
        const resultPage = await readBiAgentResultPage(actor, fence.runId, result.evidence_id, page, fresh);
        expect(resultPage.page_size).toBe(20); expect(resultPage.total).toBe(125);
        expect(resultPage.metadata).toMatchObject({ version: 2, accounting_revision: 2 }); all.push(...resultPage.rows);
      }
      const chart = await readBiAgentChart(actor, fence.runId, result.evidence_id, fresh);
      expect(chart.state).toBe('complete'); expect(chart.rows).toHaveLength(125);
      expect(chart.rows.at(-1)).toMatchObject({ key: 'p124' });
      expect(all).toHaveLength(125); expect(all.at(-1)).toMatchObject({ key: 'p124' });
      expect(await readBiAgentAnswer(actor, fence.runId, fresh)).toMatchObject({ dataset_version: 2, answer: { kind: 'answer' } });
      expect(ledger).toHaveBeenCalledTimes(2);
    } finally { await fresh.$disconnect(); }
  });

  it('keeps oversized charts available as full paged evidence instead of a truncated distribution', async () => {
    const { actor, fence, repository } = await running();
    const result = await collectBiAgentResult(fence, unique(), { dimension: 'product' }, signal(), { client: a, read: read(2001) });
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a); await complete(fence, repository);
    expect(await readBiAgentChart(actor, fence.runId, result.evidence_id, b)).toMatchObject({ state: 'table_only', total: 2001, rows: [] });
    expect(await readBiAgentResultPage(actor, fence.runId, result.evidence_id, 101, b)).toMatchObject({ total: 2001, rows: [{ key: 'p2000' }] });
  }, 20_000);

  it('persists deterministic previous-period bounds and original ratio decimals for replay', async () => {
    const { actor, fence, repository } = await running(); const source = read(1);
    const ledger = vi.fn(async (...args: Parameters<typeof source>) => {
      const data = await source(...args);
      return { ...data, range: { ...data.range, start: args[3].start, end: args[3].end },
        rows: data.rows.map((r) => ({ ...r, metrics: { ...r.metrics, contribution_margin: '0.91666667' } })) };
    });
    const result = await collectBiAgentResult(fence, unique(), { dimension: 'store', period: 'previous' }, signal(), { client: a, read: ledger });
    expect(result.query).toMatchObject({ start: '2026-08-02', end: '2026-08-31' });
    expect(result.query).not.toHaveProperty('period');
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a); await complete(fence, repository);
    const stored = await readBiAgentResultPage(actor, fence.runId, result.evidence_id, 1, b);
    expect(stored.rows).toMatchObject([{ metrics: { contribution_margin: '0.91666667' } }]);
    expect(stored.metadata).toMatchObject({ range: { start: '2026-08-02', end: '2026-08-31' } });
    expect(ledger).toHaveBeenCalledTimes(1);
  });

  it('rejects a version change midway and never promotes a first-page-only answer', async () => {
    const { fence } = await running(); const source = read();
    const changed: typeof source = vi.fn(async (...args) => {
      const result = await source(...args); return args[3].page === 2 ? { ...result, version: 3 } : result;
    });
    await expect(collectBiAgentResult(fence, unique(), {}, signal(), { client: a, read: changed })).rejects.toThrow();
    const partial = await b.biAgentResult.findFirstOrThrow({ where: { runId: fence.runId } });
    expect(partial).toMatchObject({ complete: false, collected: 100, total: 125 });
    await expect(saveBiAgentAnswer(fence, answer(partial.id), a)).rejects.toThrow();
    expect(await b.biAgentAnswer.count({ where: { runId: fence.runId } })).toBe(0);
  });

  it('rejects repeated/missing rows rather than pretending an incomplete collection is full', async () => {
    for (const mode of ['duplicate', 'missing']) {
      const { fence } = await running(); const source = read();
      const altered = async (...args: Parameters<typeof source>) => {
        const result = await source(...args);
        if (args[3].page === 2) {
          if (mode === 'duplicate') result.rows[0].key = 'p0'; else result.rows.pop();
        }
        return result;
      };
      await expect(collectBiAgentResult(fence, unique(), {}, signal(), { client: a, read: altered })).rejects.toThrow();
      expect(await b.biAgentResult.count({ where: { runId: fence.runId, complete: true } })).toBe(0);
    }
  });

  it('keeps completed facts and answers immutable, validates references and replays the same tool without another query', async () => {
    const { fence } = await running(); const ledger = read(1), op = unique();
    const result = await collectBiAgentResult(fence, op, { dimension: 'product' }, signal(), { client: a, read: ledger });
    await expect(saveBiAgentAnswer(fence, answer(randomUUID()), a)).rejects.toThrow();
    await expect(saveBiAgentAnswer(fence, { ...answer(result.evidence_id), views: [{ result_id: result.evidence_id, kind: 'line', metric: 'net_sales' }] }, a)).rejects.toThrow();
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a);
    await saveBiAgentAnswer(fence, answer(result.evidence_id), b);
    expect((await collectBiAgentResult(fence, op, { dimension: 'product' }, signal(), { client: b, read: ledger })).evidence_id).toBe(result.evidence_id);
    expect(ledger).toHaveBeenCalledTimes(1);
    await expect(collectBiAgentResult(fence, op, { dimension: 'store' }, signal(), { client: b, read: ledger })).rejects.toThrow();
    await expect(a.biAgentResult.update({ where: { id: result.evidence_id }, data: { metadata: {} } })).rejects.toThrow();
    await expect(a.biAgentResultPage.update({ where: { resultId_page: { resultId: result.evidence_id, page: 1 } }, data: { rows: [] } })).rejects.toThrow();
    await expect(a.biAgentAnswer.update({ where: { runId: fence.runId }, data: { content: {} } })).rejects.toThrow();
  });

  it('rejects stale fences and cancellation that arrives while a query is in flight', async () => {
    const first = await running();
    await expect(collectBiAgentResult({ ...first.fence, fencingToken: 99 }, unique(), {}, signal(), { client: a, read: read(1) })).rejects.toThrow();
    const second = await running(); const source = read(1);
    await expect(collectBiAgentResult(second.fence, unique(), {}, signal(), { client: a, read: async (...args) => {
      await cancelBiAgentQuestion(second.actor, second.fence.runId, b);
      return source(args[0], args[1], args[2], args[3]);
    } })).rejects.toThrow();
    expect(await a.biAgentResult.count({ where: { runId: { in: [first.fence.runId, second.fence.runId] } } })).toBe(0);
  });

  it('denies other accounts and revoked sessions without a fresh data/version query', async () => {
    const { actor, fence, repository } = await running(); const other = await identity();
    const result = await collectBiAgentResult(fence, unique(), {}, signal(), { client: a, read: read(1) });
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a); await complete(fence, repository);
    await expect(readBiAgentAnswer(other, fence.runId, b)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(readBiAgentResultPage(other, fence.runId, result.evidence_id, 1, b)).rejects.toThrow();
    await expect(readBiAgentChart(other, fence.runId, result.evidence_id, b)).rejects.toThrow();
    await a.authSession.delete({ where: { id: actor.sessionId } });
    await expect(readBiAgentAnswer(actor, fence.runId, b)).rejects.toMatchObject({ status: 403 });
    await expect(readBiAgentChart(actor, fence.runId, result.evidence_id, b)).rejects.toMatchObject({ status: 403 });
  });

  it('does not expose a shared-space conversation to a different current member', async () => {
    const owner = await identity(), member = await identity(); const projectId = unique(); projects.push(projectId);
    await a.project.create({ data: { id: projectId, name: 'Owned results shared space', ownerId: owner.actorId,
      memberships: { create: { userId: member.actorId, role: 'viewer' } } } });
    const actor = { ...owner, workspaceId: projectId }; const other = { ...member, workspaceId: projectId };
    const { fence, repository } = await running(actor);
    const result = await collectBiAgentResult(fence, unique(), {}, signal(), { client: a, read: read(1) });
    await saveBiAgentAnswer(fence, answer(result.evidence_id), a); await complete(fence, repository);
    await expect(readBiAgentAnswer(other, fence.runId, b)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await expect(readBiAgentResultPage(other, fence.runId, result.evidence_id, 1, b)).rejects.toThrow();
    await expect(readBiAgentChart(other, fence.runId, result.evidence_id, b)).rejects.toThrow();
  });

  it('retains a genuine zero-row result and rejects model inspection after lease expiry', async () => {
    const { fence } = await running();
    const result = await collectBiAgentResult(fence, unique(), {}, signal(), { client: a, read: read(0) });
    expect(result.total).toBe(0); expect(result.preview).toEqual([]);
    expect(await inspectBiAgentResultPage(fence, result.evidence_id, 1, b)).toMatchObject({ total: 0, rows: [] });
    await a.agentRun.update({ where: { id: fence.runId }, data: { leaseExpiresAt: new Date(0) } });
    await expect(inspectBiAgentResultPage(fence, result.evidence_id, 1, b)).rejects.toThrow();
    await expect(saveBiAgentAnswer(fence, answer(result.evidence_id), b)).rejects.toThrow();
  });

  const definition = { id: 'net_sales', name: '净销售额', unit: '元', formula: '付款成交金额 − 退款金额',
    missing_policy: '缺少金额时保留未知', dimensions: ['overall', 'store'], source: '订单明细与退款记录', aggregation: '金额相加' };
  const definitionAnswer = (sourceId: string) => ({ kind: 'definition', text: '净销售额是付款成交金额减去退款金额。',
    evidence_ids: [], definition_source_id: sourceId, definition_ids: ['net_sales'] });

  it('persists immutable definitions without ledger rows and replays their original source after catalog failure', async () => {
    const { actor, fence, repository } = await running(); const catalog = vi.fn(async () => [definition]);
    const source = await collectBiAgentMetricSource(fence, signal(), { client: a, catalog });
    catalog.mockRejectedValue(new Error('Catalog updated or offline'));
    expect(await collectBiAgentMetricSource(fence, signal(), { client: b, catalog })).toEqual(source);
    expect(catalog).toHaveBeenCalledTimes(1);
    await expect(a.biAgentMetricSource.update({ where: { id: source.source_id }, data: { metrics: [] } })).rejects.toThrow();
    await saveBiAgentAnswer(fence, definitionAnswer(source.source_id), a);
    await complete(fence, repository);
    const fresh = new PrismaClient({ datasourceUrl: databaseUrl! });
    try {
      expect(await readBiAgentAnswer(actor, fence.runId, fresh)).toMatchObject({ status: 'completed',
        answer: { kind: 'definition', evidence_ids: [] }, definitions: { source_id: source.source_id, metrics: [definition] } });
      expect(await fresh.biAgentResult.count({ where: { runId: fence.runId } })).toBe(0);
    } finally { await fresh.$disconnect(); }
    await expect(readBiAgentAnswer(await identity(), fence.runId, b)).rejects.toMatchObject({ code: 'BI_AGENT_NOT_FOUND' });
    await a.authSession.delete({ where: { id: actor.sessionId } });
    await expect(readBiAgentAnswer(actor, fence.runId, b)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects invented, cross-run, absent-metric and corrupted definition references', async () => {
    const first = await running(), second = await running();
    const source = await collectBiAgentMetricSource(first.fence, signal(), { client: a, catalog: async () => [definition] });
    await expect(saveBiAgentAnswer(first.fence, definitionAnswer(randomUUID()), a)).rejects.toThrow();
    await expect(saveBiAgentAnswer(second.fence, definitionAnswer(source.source_id), a)).rejects.toThrow();
    await expect(saveBiAgentAnswer(first.fence, { ...definitionAnswer(source.source_id), definition_ids: ['sales_amount'] }, a)).rejects.toThrow();
    // Even an out-of-band insert with a syntactically valid digest cannot be cited.
    const corrupt = await a.biAgentMetricSource.create({ data: { runId: second.fence.runId, metrics: [definition], digest: '0'.repeat(64) } });
    await expect(saveBiAgentAnswer(second.fence, definitionAnswer(corrupt.id), a)).rejects.toThrow();
    expect(await b.biAgentAnswer.count({ where: { runId: { in: [first.fence.runId, second.fence.runId] } } })).toBe(0);
  });

  it.each(['cancel', 'logout', 'expiry', 'abort'])('does not save dictionary evidence when %s arrives during catalog reading', async (mode) => {
    const { actor, fence } = await running(); const controller = new AbortController();
    await expect(collectBiAgentMetricSource(fence, controller.signal, { client: a, catalog: async () => {
      if (mode === 'cancel') await cancelBiAgentQuestion(actor, fence.runId, b);
      if (mode === 'logout') await b.authSession.delete({ where: { id: actor.sessionId } });
      if (mode === 'expiry') await b.agentRun.update({ where: { id: fence.runId }, data: { leaseExpiresAt: new Date(0) } });
      if (mode === 'abort') controller.abort();
      return [definition];
    } })).rejects.toThrow();
    expect(await b.biAgentMetricSource.count({ where: { runId: fence.runId } })).toBe(0);
  });

});
