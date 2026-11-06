import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { hashPiAgentProvenance } from '@/lib/services/pi-agent-provenance';
import { BiAgentProblem } from './contracts';
import { writeFenced, assertBiAgentResultFence, type BiAgentResultFence } from './fence';
import { readBiAgentMetricCatalog } from './ledger';
import { metricCatalogSchema, definitionEvidenceSchema } from './metric-contracts';
import { authorizeBiAgentRun } from './requests';
import { BI_METRICS, type BiAgentAnswerContent } from './result-contracts';

const problem = () => new BiAgentProblem('BI_AGENT_CONFLICT', 409, '指标说明来源不完整或不属于本次分析，请重新提问。');
type Source = { id: string; metrics: unknown; digest: string; createdAt: Date };
function evidence(source: Source) {
  const parsed = metricCatalogSchema.safeParse(source.metrics);
  if (!parsed.success || !parsed.data.length || hashPiAgentProvenance(source.metrics) !== source.digest) throw problem();
  return definitionEvidenceSchema.parse({ source_id: source.id, digest: source.digest,
    recorded_at: source.createdAt.toISOString(), metrics: parsed.data });
}

/** The caller supplies no definitions. Only the authorized system catalog may
 * become a source; retries reuse the immutable snapshot from this run. */
export async function collectBiAgentMetricSource(fence: BiAgentResultFence, signal: AbortSignal,
  dependencies: { client?: PrismaClient; catalog?: typeof readBiAgentMetricCatalog } = {}) {
  const client = dependencies.client ?? prisma;
  signal.throwIfAborted();
  await assertBiAgentResultFence(fence, client);
  const existing = await client.biAgentMetricSource.findUnique({ where: { runId: fence.runId } });
  if (existing) return writeFenced(fence, client, async () => { signal.throwIfAborted(); return evidence(existing); });
  const authorized = await authorizeBiAgentRun(fence.runId, client);
  const catalog = metricCatalogSchema.parse(await (dependencies.catalog ?? readBiAgentMetricCatalog)(authorized.authority, signal));
  const metrics = catalog.filter((metric) => (BI_METRICS as readonly string[]).includes(metric.id));
  if (!metrics.length || Buffer.byteLength(JSON.stringify(metrics)) > 200 * 1024) throw problem();
  signal.throwIfAborted();
  return writeFenced(fence, client, async (tx) => {
    signal.throwIfAborted();
    const previous = await tx.biAgentMetricSource.findUnique({ where: { runId: fence.runId } });
    if (previous) return evidence(previous);
    const source = await tx.biAgentMetricSource.create({ data: { runId: fence.runId,
      metrics: metrics as Prisma.InputJsonValue, digest: hashPiAgentProvenance(metrics) } });
    return evidence(source);
  });
}

/** No current-catalog lookup: historical definitions stay tied to their source. */
export async function definitionsForAnswer(client: PrismaClient | Prisma.TransactionClient, runId: string,
  content: BiAgentAnswerContent) {
  if (!content.definition_source_id) return null;
  const source = await client.biAgentMetricSource.findFirst({ where: { id: content.definition_source_id, runId } });
  if (!source) throw problem();
  const saved = evidence(source);
  const metrics = saved.metrics.filter((metric) => (content.definition_ids as readonly string[]).includes(metric.id));
  if (metrics.length !== content.definition_ids.length) throw problem();
  return { ...saved, metrics };
}
