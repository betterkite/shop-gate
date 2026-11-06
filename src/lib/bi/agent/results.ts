import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { hashPiAgentProvenance } from '@/lib/services/pi-agent-provenance';
import { recheckBiAgentSession, type BiAgentAuthority } from './authorization';
import { authorizeBiAgentRun } from './requests';
import { BiAgentProblem } from './contracts';
import { biAgentAnswerSchema, biAgentLedgerPageSchema, scopedBiAgentQuery, type BiAgentLedgerPage } from './result-contracts';
import { readBiAgentLedger } from './ledger';

export type BiAgentResultFence = { runId: string; leaseOwner: string; fencingToken: number; workspaceFencingToken: number };
const problem = () => new BiAgentProblem('BI_AGENT_CONFLICT', 409, '分析执行已变化或结果不完整，请重新提问。');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const MAX_RESULT_BYTES = 128 * 1024 * 1024;

/** Same scope-then-run lock order as durable runtime. Heartbeat versions may
 * advance, but an expired/replaced/cancelled writer never publishes facts. */
async function writeFenced<T>(fence: BiAgentResultFence, client: PrismaClient,
  write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const authorized = await authorizeBiAgentRun(fence.runId, client);
  return client.$transaction(async (tx) => {
    // Acquire locks first; only then sample the database clock. Evaluating
    // expiry before a blocked FOR UPDATE could admit a lease that expired while waiting.
    await tx.$queryRaw(Prisma.sql`SELECT execution_scope_id FROM agent_workspace_leases
      WHERE execution_scope_id=${authorized.run.executionScopeId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id=${fence.runId} FOR UPDATE`);
    const valid = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
      SELECT (r.status='running' AND r.lease_owner=${fence.leaseOwner} AND r.fencing_token=${fence.fencingToken}
        AND r.workspace_fencing_token=${fence.workspaceFencingToken} AND r.lease_expires_at>clock_timestamp()
        AND r.cancel_requested_at IS NULL AND l.status='held' AND l.active_run_id=r.id
        AND l.lease_owner=${fence.leaseOwner} AND l.fencing_token=${fence.workspaceFencingToken}
        AND l.lease_expires_at>clock_timestamp()) AS valid
      FROM agent_runs r JOIN agent_workspace_leases l ON l.execution_scope_id=r.execution_scope_id
      WHERE r.id=${fence.runId}`);
    if (!valid[0]?.valid) throw problem();
    const current = await recheckBiAgentSession(authorized.authority.sessionId, authorized.authority.workspaceId, 'run', tx);
    if (current.actorId !== authorized.authority.actorId) throw problem();
    return write(tx);
  }, { maxWait: 5000, timeout: 15_000 });
}

export async function assertBiAgentResultFence(fence: BiAgentResultFence, client: PrismaClient = prisma) {
  await writeFenced(fence, client, async () => undefined);
}

function metadata(page: BiAgentLedgerPage) {
  const { rows: _rows, page: _page, page_size: _size, ...rest } = page;
  void _rows; void _page; void _size; return rest;
}

/** All pages are saved before an evidence ID may be used in an answer. The
 * provider receives a bounded preview; the user can read the entire snapshot. */
export async function collectBiAgentResult(fence: BiAgentResultFence, operationId: string, raw: unknown,
  signal: AbortSignal, dependencies: { client?: PrismaClient; read?: typeof readBiAgentLedger } = {}) {
  if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(operationId)) throw problem();
  const client = dependencies.client ?? prisma;
  const authorized = await authorizeBiAgentRun(fence.runId, client);
  const query = scopedBiAgentQuery(authorized.pageScope, raw);
  await assertBiAgentResultFence(fence, client);
  const existing = await client.biAgentResult.findUnique({ where: { runId_operationId: { runId: fence.runId, operationId } } });
  if (existing) {
    if (!existing.complete || hashPiAgentProvenance(existing.query) !== hashPiAgentProvenance(query)) throw problem();
    signal.throwIfAborted();
    await writeFenced(fence, client, async () => undefined);
    const first = await client.biAgentResultPage.findUnique({ where: { resultId_page: { resultId: existing.id, page: 1 } } });
    return { evidence_id: existing.id, query: existing.query, metadata: existing.metadata,
      total: existing.total, preview: Array.isArray(first?.rows) ? first.rows.slice(0, 20) : [], complete: true };
  }
  let resultId: string | undefined, fingerprint: string | undefined, received = 0, bytes = 0;
  let initial: BiAgentLedgerPage | undefined;
  const keys = new Set<string>();
  for (let pageNumber = 1; ; pageNumber++) {
    signal.throwIfAborted();
    // Recheck cancellation/session on every page, not just at model-turn boundaries.
    const current = await authorizeBiAgentRun(fence.runId, client);
    const data = biAgentLedgerPageSchema.parse(await (dependencies.read ?? readBiAgentLedger)(current.authority,
      authorized.datasetId, authorized.request.datasetVersion, { ...query, page: pageNumber, page_size: 100 }, signal));
    if (data.workspace_id !== current.authority.workspaceId || data.dataset_id !== authorized.datasetId
        || data.version !== authorized.request.datasetVersion || data.accounting_revision !== data.version
        || data.page !== pageNumber || data.range.refund_basis !== query.refund_basis
        || (query.start !== undefined && data.range.start !== query.start)
        || (query.end !== undefined && data.range.end !== query.end)) throw problem();
    const meta = metadata(data), hash = hashPiAgentProvenance(meta);
    if (fingerprint !== undefined && fingerprint !== hash) throw problem();
    fingerprint = hash;
    if (data.rows.length !== Math.min(100, Math.max(0, data.total - received))) throw problem();
    for (const row of data.rows) { if (keys.has(row.key)) throw problem(); keys.add(row.key); }
    bytes += Buffer.byteLength(JSON.stringify(data.rows));
    if (bytes > MAX_RESULT_BYTES) throw new BiAgentProblem('BI_AGENT_RESULT_LIMIT', 422,
      '本次结果超过分析容量，尚未生成完整答案；请缩小日期或对象范围后重试。');
    signal.throwIfAborted();
    await writeFenced(fence, client, async (tx) => {
      if (!resultId) {
        const created = await tx.biAgentResult.create({ data: { runId: fence.runId, operationId,
          query: json(query), metadata: json(meta), total: data.total } });
        resultId = created.id;
      }
      if (data.rows.length) await tx.biAgentResultPage.create({ data: { resultId, page: pageNumber,
        rows: json(data.rows), digest: hashPiAgentProvenance(data.rows) } });
      received += data.rows.length;
      const changed = await tx.biAgentResult.updateMany({ where: { id: resultId, complete: false,
        collected: received - data.rows.length }, data: { collected: received, complete: received === data.total } });
      if (changed.count !== 1) throw problem();
    });
    initial ??= data;
    if (received === data.total) break;
  }
  return { evidence_id: resultId!, query, metadata: metadata(initial!), total: received,
    preview: initial!.rows.slice(0, 20), complete: true };
}

export async function saveBiAgentAnswer(fence: BiAgentResultFence, value: unknown, client: PrismaClient = prisma) {
  const content = biAgentAnswerSchema.parse(value);
  return writeFenced(fence, client, async (tx) => {
    const evidence = await tx.biAgentResult.findMany({ where: { id: { in: content.evidence_ids }, runId: fence.runId, complete: true } });
    if (evidence.length !== content.evidence_ids.length) throw problem();
    for (const view of content.views) {
      const query = evidence.find((e) => e.id === view.result_id)!.query as { dimension: string; metrics: string[] };
      if (!query.metrics.includes(view.metric) || (view.kind === 'line' && !['day', 'week'].includes(query.dimension))) throw problem();
    }
    const previous = await tx.biAgentAnswer.findUnique({ where: { runId: fence.runId } });
    if (previous) {
      if (hashPiAgentProvenance(previous.content) !== hashPiAgentProvenance(content)) throw problem();
      return content;
    }
    await tx.biAgentAnswer.create({ data: { runId: fence.runId, content: json(content) } });
    return content;
  });
}

async function readableRun(authority: BiAgentAuthority, runId: string, client: PrismaClient) {
  const current = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'read', client);
  if (current.actorId !== authority.actorId) throw problem();
  const run = await client.agentRun.findFirst({ where: { id: runId, actorUserId: current.actorId,
    biRequestId: { not: null }, scope: { workspaceId: current.workspaceId, kind: 'bi_dataset' } },
  select: { id: true, status: true, biRequest: { select: { datasetVersion: true, pageScope: true } } } });
  if (!run) throw new BiAgentProblem('BI_AGENT_NOT_FOUND', 404, '分析不存在或当前账号无权查看。');
  return run;
}

export async function readBiAgentAnswer(authority: BiAgentAuthority, runId: string, client: PrismaClient = prisma) {
  const run = await readableRun(authority, runId, client);
  if (run.status !== 'completed') return { status: run.status, answer: null };
  const answer = await client.biAgentAnswer.findUnique({ where: { runId } });
  if (!answer) throw problem();
  return { status: run.status, dataset_version: run.biRequest!.datasetVersion,
    page_scope: run.biRequest!.pageScope, answer: biAgentAnswerSchema.parse(answer.content) };
}

export async function readBiAgentResultPage(authority: BiAgentAuthority, runId: string, resultId: string,
  page = 1, client: PrismaClient = prisma) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw problem();
  const run = await readableRun(authority, runId, client);
  if (run.status !== 'completed') throw problem();
  const answer = await client.biAgentAnswer.findUnique({ where: { runId } });
  if (!answer || !biAgentAnswerSchema.parse(answer.content).evidence_ids.includes(resultId)) throw problem();
  return storedPage(runId, resultId, page, client);
}

/** Internal model paging still requires the same live request and fence. */
export async function inspectBiAgentResultPage(fence: BiAgentResultFence, resultId: string,
  page: number, client: PrismaClient = prisma) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw problem();
  await writeFenced(fence, client, async () => undefined);
  return storedPage(fence.runId, resultId, page, client);
}
async function storedPage(runId: string, resultId: string, page: number, client: PrismaClient) {
  const result = await client.biAgentResult.findFirst({ where: { id: resultId, runId, complete: true } });
  if (!result) throw problem();
  const offset = (page - 1) * 20;
  const chunk = await client.biAgentResultPage.findUnique({ where: { resultId_page: { resultId, page: Math.floor(offset / 100) + 1 } } });
  if (offset < result.total && (!chunk || hashPiAgentProvenance(chunk.rows) !== chunk.digest)) throw problem();
  return { evidence_id: result.id, query: result.query, metadata: result.metadata,
    total: result.total, page, page_size: 20, rows: Array.isArray(chunk?.rows) ? chunk.rows.slice(offset % 100, offset % 100 + 20) : [] };
}
