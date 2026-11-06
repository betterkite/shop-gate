import { signBiServiceClaims } from '../job-signatures';
import { recheckBiAgentSession, type BiAgentAuthority } from './authorization';
import { BiAgentProblem, biAgentPageScopeSchema, type BiAgentPageScope } from './contracts';

/** Server-only, fixed-purpose ledger calls; no model-provided URL or identity. */
export async function readBiAgentLedger(authority: BiAgentAuthority, datasetId: string,
  version: number, query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'run');
  if (current.actorId !== authority.actorId) throw new Error('BI identity changed.');
  const base = new URL(process.env.SHOPGATE_COMMERCE_API_URL ?? '');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash || base.pathname !== '/') throw new Error('BI service is not configured.');
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = signBiServiceClaims({ aud: 'shopgate-bi-v1', workspace_id: authority.workspaceId,
    dataset_id: datasetId, actor_id: authority.actorId, version, capabilities: ['ledger.read'],
    iat: issuedAt, exp: issuedAt + 120 });
  const response = await fetch(new URL('/api/v1/bi/query', base), {
    method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409) throw new BiAgentProblem('BI_AGENT_CONFLICT', 409, '数据版本已变化，请刷新后重新提问。');
    throw new Error('BI query is unavailable or denied.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('BI query returned no data.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('BI result exceeds limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  const data = result?.data;
  if (result?.success !== true || !data || data.workspace_id !== authority.workspaceId
      || data.dataset_id !== datasetId || data.version !== version || data.accounting_revision !== version) {
    throw new Error('BI query returned a different scope or version.');
  }
  const after = await recheckBiAgentSession(authority.sessionId, authority.workspaceId, 'run');
  if (after.actorId !== authority.actorId) throw new Error('BI identity changed.');
  return data;
}

/** Resolve relative/default dates once, using the same authorized ledger as BI. */
export async function resolveBiAgentPage(authority: BiAgentAuthority, datasetId: string,
  version: number, page: BiAgentPageScope): Promise<BiAgentPageScope> {
  const { module, ...query } = page;
  const data = await readBiAgentLedger(authority, datasetId, version,
    { ...query, dimension: 'overall', page: 1, page_size: 20 });
  const range = data.range as { start?: unknown; end?: unknown; refund_basis?: unknown } | undefined;
  if (!range || range.refund_basis !== page.refund_basis) throw new Error('BI range is missing.');
  return biAgentPageScopeSchema.parse({ ...query, module,
    start: range.start === null ? undefined : range.start,
    end: range.end === null ? undefined : range.end });
}
